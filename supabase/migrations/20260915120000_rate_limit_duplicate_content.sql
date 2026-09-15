-- Phase 5 fraud infra, continued (docs/06-SECURITY-FRAUD-LOOPHOLES.md §6 —
-- chat farming / spam-reply loops, the last unbuilt piece of the
-- "build-now" checklist). Session 13's device-fingerprinting/collusion
-- work targeted §2's self-dealing pattern; this targets the related but
-- distinct pattern of automating it via minimal-effort, high-frequency
-- exchanges — no shared device or concentrated pairing required, just
-- speed and repetition.
--
-- Both protections live inside fn_release_escrow, not fn_send_message — a
-- real user's message is never rejected; it just doesn't pay out past a
-- sane rate or when it's a repeat of the payee's own recent content. An
-- escrow that doesn't clear either check simply stays 'pending' instead
-- of 'released': a later fn_release_escrow call for the same thread
-- retries it once the rate window has moved on, and the existing
-- fn_refund_expired_escrows sweep (48h default,
-- 20260912082046_guard_frozen_wallets.sql) eventually refunds it to the
-- payer if it never clears — reusing the mechanism §2's fix already
-- established rather than inventing a second refund path.

create extension if not exists pg_trgm;

insert into public.pricing_config (key, value, description) values
  ('escrow_release_messages_per_minute_cap', 10, 'Per thread — escrows released in a trailing 60s window past this cap stay pending until the window moves on (docs/06-SECURITY-FRAUD-LOOPHOLES.md §6).'),
  ('escrow_release_earnings_per_hour_cap', 100, 'Per payee, globally across every thread they''re in (not just this one) — catches a farmer running several simultaneous 1:1 "conversations" to multiply throughput, which a per-thread-only cap would miss.'),
  ('duplicate_content_similarity_threshold_bps', 8200, 'pg_trgm similarity() threshold (basis points, 8200 = 0.82) above which a payee''s reply counts as a near-duplicate of one of their own recent messages.'),
  ('duplicate_content_lookback_messages', 20, 'How many of the payee''s own most recent messages, across all threads, a new reply is compared against for near-duplicate detection.')
on conflict (key) do nothing;

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

  -- Live-aggregated, not a separate counter table — same style
  -- fn_buy_credit's velocity cap already uses. Incremented locally below
  -- as this call itself releases more, so one call processing a burst of
  -- 20 pending escrows at once still respects the cap, not just what was
  -- already released before this call started.
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
      continue; -- rate-limited: leave pending, a later call retries once the window moves on
    end if;

    select body into v_message_body from messages where id = v_escrow.message_id;

    v_is_duplicate := false;
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

    if v_is_duplicate then
      -- One signal per rolling hour per user, not one per repeated
      -- message — same idempotency posture as fn_run_collusion_detection,
      -- avoids flooding fraud_signals from a single farming session.
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
      continue; -- leave pending; not this function's job to refund/reject, same posture as reconcile-topups
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
