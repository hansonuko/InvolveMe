-- Fixes a real bug found by manually running fn_release_escrow against a
-- synthetic fixture immediately after creating it
-- (20260915120000_rate_limit_duplicate_content.sql), not caught by
-- review: the duplicate-content check compared EVERY escrow's message
-- body against payee B's recent history, regardless of who actually sent
-- that particular message. Since every escrow in a 1:1 thread has
-- payee_id = participant_b always (the fixed payer/payee shape this
-- schema uses — see fn_send_message's own header comment), the payer A's
-- own opening messages were being run through the same "is this similar
-- to something B said" check as B's actual replies — and in the test
-- fixture (deliberately near-identical opener/reply text), A's own
-- message got flagged as a duplicate of B's reply and never released,
-- which makes no sense: A is the one paying, not the one being evaluated
-- for farming behavior.
--
-- Fixed by fetching the escrow's message sender_id alongside its body and
-- only running the duplicate check when the message was actually sent by
-- the payee (participant_b) — a payer-sent message is never
-- duplicate-checked, only rate-limit-checked.

create or replace function public.fn_release_escrow(p_thread_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_earnings_pending_wallet_id uuid;
  v_earnings_pending_frozen boolean;
  v_withdrawable_cash_wallet_id uuid;
  v_withdrawable_cash_frozen boolean;
  v_platform_wallet_id uuid;
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
    where user_id = v_thread.participant_b and kind = 'earnings_pending'
    for update;

  select id, is_frozen into v_withdrawable_cash_wallet_id, v_withdrawable_cash_frozen from wallets
    where user_id = v_thread.participant_b and kind = 'withdrawable_cash'
    for update;

  if v_earnings_pending_frozen or v_withdrawable_cash_frozen then
    raise exception 'wallet_frozen';
  end if;

  select id into v_platform_wallet_id from wallets
    where kind = 'platform_revenue_earnings_cut' and user_id is null
    for update;

  select count(*) into v_thread_release_count_1m from escrows
    where thread_id = p_thread_id and status = 'released' and created_at > now() - interval '1 minute';

  select count(*) into v_payee_release_count_1h from escrows
    where payee_id = v_thread.participant_b and status = 'released' and created_at > now() - interval '1 hour';

  for v_escrow in
    select * from escrows
    where thread_id = p_thread_id and status = 'pending'
    order by created_at
    for update
  loop
    if v_thread_release_count_1m >= v_per_minute_cap or v_payee_release_count_1h >= v_per_hour_cap then
      continue;
    end if;

    select body, sender_id into v_message_body, v_message_sender_id
      from messages where id = v_escrow.message_id;

    v_is_duplicate := false;
    -- Only ever check content the payee themselves sent — a payer-sent
    -- message (fixed payer/payee per thread, so this is always
    -- participant_a) has nothing to do with B's own farming behavior.
    if v_message_sender_id = v_thread.participant_b then
      for v_recent_body in
        select body from messages
        where sender_id = v_thread.participant_b and id <> v_escrow.message_id
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
        where user_id = v_thread.participant_b
          and signal_type = 'duplicate_content'
          and created_at > now() - interval '1 hour'
      ) then
        insert into fraud_signals (user_id, signal_type, severity, metadata)
        values (
          v_thread.participant_b, 'duplicate_content', 'medium',
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

    if v_platform_cut > 0 then
      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_platform_wallet_id, v_platform_cut, 'escrow_release_platform_cut', 'escrow', v_escrow.id);
    end if;

    update escrows set status = 'released' where id = v_escrow.id;
    update messages set status = 'released' where id = v_escrow.message_id;

    v_released_count := v_released_count + 1;
    v_thread_release_count_1m := v_thread_release_count_1m + 1;
    v_payee_release_count_1h := v_payee_release_count_1h + 1;
  end loop;

  return v_released_count;
end;
$$;
