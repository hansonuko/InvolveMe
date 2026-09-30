-- =============================================================================
-- Restore the duplicate-content payer guard in fn_release_escrow.
--
-- 20260915121500_fix_duplicate_content_payer_leak.sql added a guard so the
-- release-time duplicate-content check only ever examined a message the
-- PAYEE wrote. 20260926140000_thread_payer_role.sql then rewrote this
-- function to be payer-role-agnostic and, in the process, dropped that
-- guard: the live definition still SELECTs sender_id into
-- v_message_sender_id and then never reads it -- a dead variable, which is
-- what a lost guard looks like. Confirmed against the deployed function via
-- pg_get_functiondef before writing this migration, not just against the
-- migration file.
--
-- Effect: the loop is filtered to `payee_id = p_sender_id`, so v_message_body
-- is whatever message that escrow is FOR -- frequently one the payer wrote --
-- while the lookback compares against messages the PAYEE sent. A payer's
-- message that happens to resemble the payee's replies is therefore flagged
-- as the payee's duplicate and its escrow never releases. Both shapes exist
-- in live data (payer-authored and payee-authored escrow messages), because
-- the payer role became mutable in that same migration, so this misfires in
-- ordinary use rather than only in a contrived case.
--
-- This is the exact failure two fraud-functions.test.js cases have been
-- reporting since 2026-09-26 ("the payer A's own (textually similar) opening
-- message still releases" and "a genuinely varied back-and-forth releases
-- every escrow, none flagged as duplicate") -- both leave escrows pending
-- that should have released.
--
-- Fix: restore the guard, keyed off p_sender_id rather than the
-- participant_b the original used, so it stays correct now that either
-- participant can hold the payer role. Nothing else in the function changes;
-- the body below is the deployed definition with only the guard re-added.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_release_escrow(p_thread_id uuid, p_sender_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_thread threads%rowtype;
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_earnings_pending_wallet_id uuid;
  v_earnings_pending_frozen boolean;
  v_withdrawable_cash_wallet_id uuid;
  v_withdrawable_cash_frozen boolean;
  v_escrow record;
  v_platform_cut bigint;
  v_payee_amount bigint;
  v_released_count integer := 0;
  v_per_minute_cap bigint;
  v_per_hour_cap bigint;
  v_similarity_threshold_bps bigint;
  v_lookback_n bigint;
  v_thread_release_count_1m bigint;
  v_payee_release_count_1h bigint;
  v_message_body text;
  v_message_sender_id uuid;
  v_recent_body text;
  v_is_duplicate boolean;
begin
  select * into v_thread from threads where id = p_thread_id;
  if not found then
    raise exception 'thread_not_found';
  end if;

  select value into v_take_bps from pricing_config where key = 'platform_earning_take_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';
  select value into v_per_minute_cap from pricing_config where key = 'escrow_release_messages_per_minute_cap';
  select value into v_per_hour_cap from pricing_config where key = 'escrow_release_earnings_per_hour_cap';
  select value into v_similarity_threshold_bps from pricing_config where key = 'duplicate_content_similarity_threshold_bps';
  select value into v_lookback_n from pricing_config where key = 'duplicate_content_lookback_messages';

  select id, is_frozen into v_earnings_pending_wallet_id, v_earnings_pending_frozen from wallets
    where user_id = p_sender_id and kind = 'earnings_pending'
    for update;

  select id, is_frozen into v_withdrawable_cash_wallet_id, v_withdrawable_cash_frozen from wallets
    where user_id = p_sender_id and kind = 'withdrawable_cash'
    for update;

  if v_earnings_pending_frozen or v_withdrawable_cash_frozen then
    raise exception 'wallet_frozen';
  end if;

  select count(*) into v_thread_release_count_1m from escrows
    where thread_id = p_thread_id and status = 'released' and created_at > now() - interval '1 minute';

  select count(*) into v_payee_release_count_1h from escrows
    where payee_id = p_sender_id and status = 'released' and created_at > now() - interval '1 hour';

  for v_escrow in
    select * from escrows
    where thread_id = p_thread_id and payee_id = p_sender_id and status = 'pending'
    order by created_at
    for update
  loop
    if v_thread_release_count_1m >= v_per_minute_cap or v_payee_release_count_1h >= v_per_hour_cap then
      continue;
    end if;

    select body, sender_id into v_message_body, v_message_sender_id
      from messages where id = v_escrow.message_id;

    v_is_duplicate := false;
    -- Only ever duplicate-check a message the PAYEE themselves wrote. The
    -- loop above is filtered to payee_id = p_sender_id, so p_sender_id is
    -- this escrow's payee; an escrow whose message was written by the payer
    -- is rate-limit-checked but never content-checked, since the payer is
    -- not the party being evaluated for reply-farming.
    if v_message_sender_id = p_sender_id then
    for v_recent_body in
      select body from messages
      where sender_id = p_sender_id and id <> v_escrow.message_id
      order by created_at desc
      limit v_lookback_n
    loop
      if similarity(v_message_body, v_recent_body) >= (v_similarity_threshold_bps::numeric / 10000) then
        v_is_duplicate := true;
        exit;
      end if;
    end loop;
    end if;

    if v_is_duplicate then
      if not exists (
        select 1 from fraud_signals
        where user_id = p_sender_id
          and signal_type = 'duplicate_content'
          and created_at > now() - interval '1 hour'
      ) then
        insert into fraud_signals (user_id, signal_type, severity, metadata)
        values (
          p_sender_id, 'duplicate_content', 'medium',
          jsonb_build_object('thread_id', p_thread_id, 'message_id', v_escrow.message_id)
        );
      end if;
      continue;
    end if;

    v_platform_cut := round(v_escrow.credits_held::numeric * v_take_bps / 10000)::bigint;
    v_payee_amount := v_escrow.credits_held - v_platform_cut;

    if v_payee_amount > 0 then
      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_earnings_pending_wallet_id, v_payee_amount, 'escrow_release_earning', 'escrow', v_escrow.id);

      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_earnings_pending_wallet_id, -v_payee_amount, 'earnings_conversion', 'escrow', v_escrow.id);

      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_withdrawable_cash_wallet_id, v_payee_amount * v_unit_kobo, 'earnings_conversion', 'escrow', v_escrow.id);
    end if;

    perform fn_credit_platform_revenue(
      'platform_revenue_earnings_cut', 'platform_reserve_earnings_cut',
      v_platform_cut, 'escrow_release_platform_cut', 'escrow', v_escrow.id
    );

    update escrows set status = 'released' where id = v_escrow.id;
    update messages set status = 'released' where id = v_escrow.message_id;

    v_released_count := v_released_count + 1;
    v_thread_release_count_1m := v_thread_release_count_1m + 1;
    v_payee_release_count_1h := v_payee_release_count_1h + 1;
  end loop;

  return v_released_count;
end;
$function$;


revoke execute on function public.fn_release_escrow(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_release_escrow(uuid, uuid) to service_role;
