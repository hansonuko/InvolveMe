-- SECURITY DEFINER functions — every money-moving operation in the app goes
-- through one of these, called from an Edge Function using the service_role
-- key after that function has already verified the caller's JWT. Per
-- CLAUDE.md rule #1: no financial logic on the client, ever.
--
-- Each function is owned by the migration role, which is what lets it
-- bypass RLS to move credits between two different users' wallets in one
-- atomic transaction. Because that also means EXECUTE would default to
-- PUBLIC (function grants, unlike table grants, default open), every
-- function here is explicitly locked to service_role only at the bottom of
-- this file — without that, an anon/authenticated caller could invoke these
-- directly via PostgREST RPC and pass an arbitrary p_sender_id/p_user_id to
-- impersonate anyone, since the functions trust their arguments rather than
-- re-deriving identity from auth.uid() (the Edge Function layer is what's
-- responsible for confirming p_sender_id/p_user_id actually is the caller).
--
-- Lock ordering (docs/02-DATA-MODEL.md §3): every function that touches more
-- than one wallet always locks in the same relative order — payer, then
-- payee, then platform — across every call site. Consistent ordering (not
-- sorting by id) is what prevents deadlocks here, since this is the only
-- code path that acquires these locks.
--
-- v1 simplification, documented not hidden: the 'escrow_hold' ledger reason
-- (defined in the item-1 CHECK constraint) is deliberately unused below —
-- the escrows table itself is the record of a held credit; adding a second
-- ledger leg for it would require a clearing-account wallet that adds
-- complexity without changing what CLAUDE.md actually requires (that each
-- wallet's own balance reconciles against its own ledger entries). The
-- per-wallet invariant holds without it.
--
-- Also not in this pass: the docs/03-ECONOMY-LEDGER.md §3 wallet_float_kobo
-- dust-carry mechanic for top-up rounding remainders — sub-10-kobo amounts,
-- flagged as a deferred follow-up rather than silently dropped.

-- =============================================================================
-- fn_start_thread — find-or-create the thread for a payer/payee pair.
-- Not in the original item-3 list but necessary connective tissue: the
-- send-message contract in docs/05-API-REALTIME-SPEC.md takes a thread_id,
-- and nothing else creates one.
-- =============================================================================

create function public.fn_start_thread(p_payer_id uuid, p_payee_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
begin
  if p_payer_id = p_payee_id then
    raise exception 'cannot_thread_with_self';
  end if;

  select id into v_thread_id
  from threads
  where participant_a = p_payer_id and participant_b = p_payee_id;

  if not found then
    insert into threads (participant_a, participant_b)
    values (p_payer_id, p_payee_id)
    returning id into v_thread_id;
  end if;

  return v_thread_id;
end;
$$;

-- =============================================================================
-- fn_release_escrow — releases every pending escrow in a thread to the
-- payee (minus the platform's cut), called by fn_send_message when the
-- payee replies. Exposed as its own function (rather than inlined) so the
-- escrow-expiry cron (Phase 1 item 5) and direct testing can call it too.
--
-- Per docs/03-ECONOMY-LEDGER.md §6, earnings convert to cash "automatically
-- and immediately on release" — not left sitting in earnings_pending. So
-- each release is actually two ledger legs on the payee's side: credit
-- earnings_pending (reason escrow_release_earning, for an auditable "you
-- earned N credits" line), then immediately debit that same amount back out
-- and credit withdrawable_cash in kobo (reason earnings_conversion). Net
-- effect: earnings_pending nets to zero after every release; the doc's own
-- ledger-reason list already has both reasons, which is what gave this away.
-- =============================================================================

create function public.fn_release_escrow(p_thread_id uuid)
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
  v_withdrawable_cash_wallet_id uuid;
  v_platform_wallet_id uuid;
  v_escrow record;
  v_platform_cut bigint;
  v_payee_amount bigint;
  v_released_count integer := 0;
begin
  select * into v_thread from threads where id = p_thread_id;
  if not found then
    raise exception 'thread_not_found';
  end if;

  select value into v_take_bps from pricing_config where key = 'platform_earning_take_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

  -- Lock order: earnings_pending, then withdrawable_cash, then platform —
  -- always this order, every call site.
  select id into v_earnings_pending_wallet_id from wallets
    where user_id = v_thread.participant_b and kind = 'earnings_pending'
    for update;

  select id into v_withdrawable_cash_wallet_id from wallets
    where user_id = v_thread.participant_b and kind = 'withdrawable_cash'
    for update;

  select id into v_platform_wallet_id from wallets
    where kind = 'platform_revenue_earnings_cut' and user_id is null
    for update;

  for v_escrow in
    select * from escrows
    where thread_id = p_thread_id and status = 'pending'
    order by created_at
    for update
  loop
    v_platform_cut := round(v_escrow.credits_held::numeric * v_take_bps / 10000)::bigint;
    v_payee_amount := v_escrow.credits_held - v_platform_cut;

    if v_payee_amount > 0 then
      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_earnings_pending_wallet_id, v_payee_amount, 'escrow_release_earning', 'escrow', v_escrow.id);

      -- Immediate auto-conversion to cash (see header comment).
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
  end loop;

  return v_released_count;
end;
$$;

-- =============================================================================
-- fn_refund_expired_escrows — bulk refund of unanswered-message escrows past
-- their expiry. Standalone so Phase 1 item 5's cron just has to call it on a
-- schedule; not wired to pg_cron yet in this migration.
-- =============================================================================

create function public.fn_refund_expired_escrows()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escrow record;
  v_payer_wallet_id uuid;
  v_refunded_count integer := 0;
begin
  for v_escrow in
    select * from escrows
    where status = 'pending' and expires_at < now()
    order by created_at
    for update
  loop
    select id into v_payer_wallet_id from wallets
      where user_id = v_escrow.payer_id and kind = 'topup_credit'
      for update;

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_payer_wallet_id, v_escrow.credits_held, 'escrow_refund_unanswered', 'escrow', v_escrow.id);

    update escrows set status = 'refunded' where id = v_escrow.id;
    update messages set status = 'refunded' where id = v_escrow.message_id;

    v_refunded_count := v_refunded_count + 1;
  end loop;

  return v_refunded_count;
end;
$$;

-- =============================================================================
-- fn_send_message — the core function. Debits the payer for every message
-- in a thread (whichever side sends it), escrows it, and releases all
-- pending escrows in the thread when the payee replies.
-- =============================================================================

create function public.fn_send_message(p_thread_id uuid, p_sender_id uuid, p_body text)
returns table (
  message_id uuid,
  credits_charged bigint,
  word_count integer,
  status text,
  payer_balance_after bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_is_reply boolean;
  v_word_count integer;
  v_block_size bigint;
  v_base_credits bigint;
  v_max_words bigint;
  v_credits bigint;
  v_refund_hours bigint;
  v_payer_wallet_id uuid;
  v_payer_balance bigint;
  v_message_id uuid;
begin
  select * into v_thread from threads where id = p_thread_id for update;
  if not found then
    raise exception 'thread_not_found';
  end if;

  if p_sender_id not in (v_thread.participant_a, v_thread.participant_b) then
    raise exception 'not_a_participant';
  end if;

  if v_thread.is_blocked then
    raise exception 'thread_blocked';
  end if;

  v_is_reply := (p_sender_id = v_thread.participant_b);

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 then
    raise exception 'empty_message';
  end if;

  select value into v_block_size from pricing_config where key = 'message_word_block_size';
  select value into v_base_credits from pricing_config where key = 'message_base_credits';
  select value into v_max_words from pricing_config where key = 'message_max_words';
  select value into v_refund_hours from pricing_config where key = 'escrow_unanswered_refund_hours';

  if v_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
  end if;

  v_credits := (v_base_credits * greatest(ceil(v_word_count::numeric / v_block_size), 1))::bigint;

  -- Lock order: payer wallet always first (this function only ever locks
  -- one wallet directly; fn_release_escrow below locks payee then platform).
  select id, balance into v_payer_wallet_id, v_payer_balance
  from wallets
  where user_id = v_thread.participant_a and kind = 'topup_credit'
  for update;

  if v_payer_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_payer_balance;
  end if;

  insert into messages (thread_id, sender_id, body, word_count, credits_charged, status)
  values (p_thread_id, p_sender_id, p_body, v_word_count, v_credits, 'escrowed')
  returning id into v_message_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_payer_wallet_id, -v_credits, 'message_debit', 'message', v_message_id);

  insert into escrows (thread_id, message_id, payer_id, payee_id, credits_held, status, expires_at)
  values (
    p_thread_id, v_message_id, v_thread.participant_a, v_thread.participant_b,
    v_credits, 'pending', now() + make_interval(hours => v_refund_hours::integer)
  );

  update threads set last_message_at = now() where id = p_thread_id;

  if v_is_reply then
    perform fn_release_escrow(p_thread_id);
  end if;

  select balance into v_payer_balance from wallets where id = v_payer_wallet_id;

  return query select v_message_id, v_credits, v_word_count, 'escrowed'::text, v_payer_balance;
end;
$$;

-- =============================================================================
-- fn_buy_credit — creates a pending top-up request with the fee/credit
-- split already computed (deterministic from pricing_config, doesn't need
-- to wait on the payment provider). Issuance happens in fn_confirm_topup,
-- only once the provider webhook confirms the charge.
-- =============================================================================

create function public.fn_buy_credit(p_user_id uuid, p_amount_kobo bigint, p_provider text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_bps bigint;
  v_unit_kobo bigint;
  v_fee_kobo bigint;
  v_credits bigint;
  v_topup_id uuid;
begin
  if p_amount_kobo <= 0 then
    raise exception 'invalid_amount';
  end if;

  select value into v_fee_bps from pricing_config where key = 'platform_topup_fee_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

  v_fee_kobo := round(p_amount_kobo::numeric * v_fee_bps / 10000)::bigint;
  v_credits := floor((p_amount_kobo - v_fee_kobo)::numeric / v_unit_kobo)::bigint;

  insert into topups (user_id, amount_kobo_paid, platform_fee_kobo, credits_issued, provider, status)
  values (p_user_id, p_amount_kobo, v_fee_kobo, v_credits, p_provider, 'pending')
  returning id into v_topup_id;

  return v_topup_id;
end;
$$;

-- =============================================================================
-- fn_confirm_topup — called from the payment webhook handler once the
-- provider confirms the charge. Idempotent: re-confirming an already-
-- completed topup is a no-op, so a retried/duplicate webhook can't double-
-- issue credits.
-- =============================================================================

create function public.fn_confirm_topup(p_topup_id uuid, p_provider_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup topups%rowtype;
  v_wallet_id uuid;
  v_platform_wallet_id uuid;
begin
  select * into v_topup from topups where id = p_topup_id for update;
  if not found then
    raise exception 'topup_not_found';
  end if;

  if v_topup.status = 'completed' then
    return; -- idempotent no-op on webhook retry
  end if;

  if v_topup.status <> 'pending' then
    raise exception 'topup_not_pending: current status is %', v_topup.status;
  end if;

  select id into v_wallet_id from wallets
    where user_id = v_topup.user_id and kind = 'topup_credit'
    for update;

  select id into v_platform_wallet_id from wallets
    where kind = 'platform_revenue_topup_fees' and user_id is null
    for update;

  update topups set status = 'completed', provider_ref = p_provider_ref where id = p_topup_id;

  if v_topup.credits_issued > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_wallet_id, v_topup.credits_issued, 'topup_purchase', 'topup', p_topup_id);
  end if;

  if v_topup.platform_fee_kobo > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_platform_wallet_id, v_topup.platform_fee_kobo, 'topup_platform_fee', 'topup', p_topup_id);
  end if;
end;
$$;

-- =============================================================================
-- fn_initiate_withdrawal — the DB-side half of a withdrawal. Debits
-- withdrawable_cash immediately (status 'processing'); the Edge Function
-- calling this is responsible for then calling the PaymentProvider transfer
-- API and calling fn_fail_withdrawal below if that call fails, so the debit
-- doesn't strand without a compensating path. No platform fee here — per
-- docs/03-ECONOMY-LEDGER.md §8, the 20% take already happened at escrow
-- release; withdrawal itself is fee-free by design.
-- =============================================================================

create function public.fn_initiate_withdrawal(
  p_user_id uuid,
  p_bank_account_id uuid,
  p_amount_kobo bigint default null,
  p_bypass_minimum boolean default false
)
returns table (withdrawal_id uuid, amount_kobo bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kyc_tier smallint;
  v_bank_ok boolean;
  v_wallet_id uuid;
  v_balance bigint;
  v_amount bigint;
  v_min_kobo bigint;
  v_tier1_cap bigint;
  v_already_withdrawn_24h bigint;
  v_withdrawal_id uuid;
begin
  select kyc_tier into v_kyc_tier from users where id = p_user_id;
  if v_kyc_tier is null or v_kyc_tier < 1 then
    raise exception 'kyc_required';
  end if;

  select name_match_verified into v_bank_ok
  from bank_accounts
  where id = p_bank_account_id and user_id = p_user_id;

  if v_bank_ok is not true then
    raise exception 'bank_account_unverified';
  end if;

  select id, balance into v_wallet_id, v_balance
  from wallets
  where user_id = p_user_id and kind = 'withdrawable_cash'
  for update;

  v_amount := coalesce(p_amount_kobo, v_balance);

  if v_amount <= 0 or v_amount > v_balance then
    raise exception 'invalid_amount: requested % available %', v_amount, v_balance;
  end if;

  select value into v_min_kobo from pricing_config where key = 'withdrawal_min_kobo';
  if not p_bypass_minimum and v_amount < v_min_kobo then
    raise exception 'below_minimum: % is below the % minimum', v_amount, v_min_kobo;
  end if;

  if v_kyc_tier = 1 then
    select value into v_tier1_cap from pricing_config where key = 'kyc_tier1_daily_withdrawal_cap_kobo';

    select coalesce(sum(w.amount_kobo), 0) into v_already_withdrawn_24h
    from withdrawals w
    where w.user_id = p_user_id
      and w.created_at > now() - interval '24 hours'
      and w.status in ('pending', 'processing', 'paid');

    if v_already_withdrawn_24h + v_amount > v_tier1_cap then
      raise exception 'daily_limit_exceeded: % already withdrawn in 24h, cap is %', v_already_withdrawn_24h, v_tier1_cap;
    end if;
  end if;

  insert into withdrawals (user_id, amount_kobo, platform_fee_kobo, bank_account_id, status, triggered_by)
  values (p_user_id, v_amount, 0, p_bank_account_id, 'processing', case when p_amount_kobo is null then 'auto_sweep' else 'manual' end)
  returning id into v_withdrawal_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_wallet_id, -v_amount, 'withdrawal_payout', 'withdrawal', v_withdrawal_id);

  return query select v_withdrawal_id, v_amount;
end;
$$;

-- =============================================================================
-- fn_fail_withdrawal — compensating transaction if the provider transfer
-- call fails after fn_initiate_withdrawal already committed the debit.
-- Without this, a failed provider call would strand a debit with no way
-- back to the user's balance.
-- =============================================================================

create function public.fn_fail_withdrawal(p_withdrawal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_withdrawal withdrawals%rowtype;
  v_wallet_id uuid;
begin
  select * into v_withdrawal from withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'withdrawal_not_found';
  end if;

  if v_withdrawal.status <> 'processing' then
    raise exception 'withdrawal_not_processing: current status is %', v_withdrawal.status;
  end if;

  select id into v_wallet_id from wallets
    where user_id = v_withdrawal.user_id and kind = 'withdrawable_cash'
    for update;

  update withdrawals set status = 'failed' where id = p_withdrawal_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_wallet_id, v_withdrawal.amount_kobo, 'withdrawal_refund_failed', 'withdrawal', p_withdrawal_id);
end;
$$;

-- =============================================================================
-- Lock every function to service_role only (see header comment).
-- =============================================================================

revoke execute on function public.fn_start_thread(uuid, uuid) from public;
revoke execute on function public.fn_release_escrow(uuid) from public;
revoke execute on function public.fn_refund_expired_escrows() from public;
revoke execute on function public.fn_send_message(uuid, uuid, text) from public;
revoke execute on function public.fn_buy_credit(uuid, bigint, text) from public;
revoke execute on function public.fn_confirm_topup(uuid, text) from public;
revoke execute on function public.fn_initiate_withdrawal(uuid, uuid, bigint, boolean) from public;
revoke execute on function public.fn_fail_withdrawal(uuid) from public;

grant execute on function public.fn_start_thread(uuid, uuid) to service_role;
grant execute on function public.fn_release_escrow(uuid) to service_role;
grant execute on function public.fn_refund_expired_escrows() to service_role;
grant execute on function public.fn_send_message(uuid, uuid, text) to service_role;
grant execute on function public.fn_buy_credit(uuid, bigint, text) to service_role;
grant execute on function public.fn_confirm_topup(uuid, text) to service_role;
grant execute on function public.fn_initiate_withdrawal(uuid, uuid, bigint, boolean) to service_role;
grant execute on function public.fn_fail_withdrawal(uuid) to service_role;
