-- Found while documenting item 5: fn_run_reconciliation_check sets
-- wallets.is_frozen on a mismatch, but nothing actually checked that flag
-- anywhere — freezing a wallet did literally nothing to stop further
-- activity on it, which defeats the entire point per docs/02-DATA-MODEL.md
-- §4 ("freezes new writes to that wallet... until an admin clears it").
--
-- CREATE OR REPLACE on every function that locks a wallet it might credit
-- or debit, adding a check right after the lock (`for update` already
-- serializes concurrent access, so the flag read here can't race). Applied
-- to every wallet lock in every function, including the refund path — a
-- freeze should mean freeze, not "freeze except for a few code paths."
--
-- Only change from each function's previous version is the added
-- is_frozen guard(s); all other logic is identical to the item-3 and
-- item-5 migrations.

create or replace function public.fn_send_message(p_thread_id uuid, p_sender_id uuid, p_body text)
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
  v_payer_frozen boolean;
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

  select id, balance, is_frozen into v_payer_wallet_id, v_payer_balance, v_payer_frozen
  from wallets
  where user_id = v_thread.participant_a and kind = 'topup_credit'
  for update;

  if v_payer_frozen then
    raise exception 'wallet_frozen';
  end if;

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
begin
  select * into v_thread from threads where id = p_thread_id;
  if not found then
    raise exception 'thread_not_found';
  end if;

  select value into v_take_bps from pricing_config where key = 'platform_earning_take_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

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

create or replace function public.fn_refund_expired_escrows()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_escrow record;
  v_payer_wallet_id uuid;
  v_payer_frozen boolean;
  v_refunded_count integer := 0;
begin
  for v_escrow in
    select * from escrows
    where status = 'pending' and expires_at < now()
    order by created_at
    for update
  loop
    select id, is_frozen into v_payer_wallet_id, v_payer_frozen from wallets
      where user_id = v_escrow.payer_id and kind = 'topup_credit'
      for update;

    if v_payer_frozen then
      -- leave this one pending rather than aborting the whole sweep —
      -- it'll be picked up again once an admin clears the freeze.
      continue;
    end if;

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_payer_wallet_id, v_escrow.credits_held, 'escrow_refund_unanswered', 'escrow', v_escrow.id);

    update escrows set status = 'refunded' where id = v_escrow.id;
    update messages set status = 'refunded' where id = v_escrow.message_id;

    v_refunded_count := v_refunded_count + 1;
  end loop;

  return v_refunded_count;
end;
$$;

create or replace function public.fn_confirm_topup(p_topup_id uuid, p_provider_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup topups%rowtype;
  v_wallet_id uuid;
  v_wallet_frozen boolean;
  v_platform_wallet_id uuid;
begin
  select * into v_topup from topups where id = p_topup_id for update;
  if not found then
    raise exception 'topup_not_found';
  end if;

  if v_topup.status = 'completed' then
    return;
  end if;

  if v_topup.status <> 'pending' then
    raise exception 'topup_not_pending: current status is %', v_topup.status;
  end if;

  select id, is_frozen into v_wallet_id, v_wallet_frozen from wallets
    where user_id = v_topup.user_id and kind = 'topup_credit'
    for update;

  if v_wallet_frozen then
    raise exception 'wallet_frozen';
  end if;

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

create or replace function public.fn_initiate_withdrawal(
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
  v_wallet_frozen boolean;
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

  select id, balance, is_frozen into v_wallet_id, v_balance, v_wallet_frozen
  from wallets
  where user_id = p_user_id and kind = 'withdrawable_cash'
  for update;

  if v_wallet_frozen then
    raise exception 'wallet_frozen';
  end if;

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
