-- Admin dashboard Phase F piece 2 (docs/14-ADMIN-DASHBOARD-SCOPING.md §5/§9)
-- — the withdrawal debit itself: platform_withdrawals + the three
-- functions that initiate/complete/fail it.
--
-- Deliberately, and unlike every other function in this migration file's
-- lineage that touches money: NONE of these call out to
-- packages/payments' initiatePayout() — that stays one layer up, exactly
-- where fn_initiate_withdrawal already keeps it (see
-- supabase/functions/withdraw/index.ts: RPC debits, then the calling code
-- calls the provider, then RPCs again to complete/fail). This piece is
-- pure Postgres, testable the same safe way every prior piece in this
-- phase was — no live call to a real payment provider ever happens as a
-- side effect of running this migration's own test suite. Piece 3 is
-- where the actual initiatePayout() wiring, the webhook-flutterwave
-- routing to these completion functions, and the UI all land together —
-- that piece moves real company money once exercised for real and gets a
-- different verification posture (careful code review against the live
-- withdraw/index.ts pattern, never an automated live-execution test).
--
-- fn_admin_initiate_platform_withdrawal only ever debits
-- platform_revenue_topup_fees (the cash-denominated wallet) — piece 1
-- already established platform_revenue_earnings_cut (credits) has to be
-- converted first via fn_admin_convert_platform_earnings_to_cash, so this
-- function doesn't need to (and shouldn't) touch it directly.
--
-- Status vocabulary ('processing'/'paid'/'failed') and the complete/fail
-- pair's idempotent-no-op-on-retry shape are copied exactly from
-- fn_complete_withdrawal/fn_fail_withdrawal
-- (20260912123949_webhook_events_and_withdrawal_completion.sql,
-- 20260912072753_security_definer_functions.sql) — a webhook can and does
-- redeliver the same event, and both existing functions already handle
-- that by treating "already in the terminal state this call would set"
-- as a silent success rather than an error.

-- =============================================================================
-- platform_withdrawals — one row per admin-initiated treasury withdrawal.
-- pending_action_id is kept (not just referenced transiently) so the
-- audit trail directly shows which dual-approved proposal authorized
-- each withdrawal, same as ledger_entries.ref_id already does.
-- =============================================================================

create table public.platform_withdrawals (
  id uuid primary key default gen_random_uuid(),
  currency text not null,
  amount_minor bigint not null,
  platform_bank_account_id uuid not null references public.platform_bank_accounts(id),
  status text not null default 'processing' check (status in ('processing', 'paid', 'failed')),
  initiated_by_admin_id uuid not null references public.admin_users(id),
  pending_action_id uuid not null references public.admin_pending_actions(id),
  provider_reference text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index platform_withdrawals_status_idx on public.platform_withdrawals (status, created_at desc);

alter table public.platform_withdrawals enable row level security;

revoke insert, update, delete on public.platform_withdrawals from public, anon, authenticated, service_role;
grant select on public.platform_withdrawals to service_role;

-- =============================================================================
-- New action_type + permission mapping, and the two new ledger vocabulary
-- values this phase needs — same widen-in-the-migration-that-needs-it
-- precedent as every prior addition to these three constraints.
-- =============================================================================

alter table public.admin_pending_actions drop constraint admin_pending_actions_action_type_check;
alter table public.admin_pending_actions add constraint admin_pending_actions_action_type_check
  check (action_type in ('pricing_config_update', 'manual_ledger_adjustment', 'platform_bank_account_registration', 'platform_withdrawal'));

create or replace function public.fn_admin_pending_action_required_permission(p_action_type text)
returns text
language sql
immutable
as $$
  select case p_action_type
    when 'pricing_config_update' then 'edit_pricing_config'
    when 'manual_ledger_adjustment' then 'post_manual_adjustment'
    when 'platform_bank_account_registration' then 'manage_platform_bank_accounts'
    when 'platform_withdrawal' then 'initiate_platform_withdrawal'
    else null
  end;
$$;

alter table public.ledger_entries drop constraint ledger_entries_ref_type_check;
alter table public.ledger_entries add constraint ledger_entries_ref_type_check
  check (ref_type in ('message', 'topup', 'withdrawal', 'escrow', 'status_update', 'credit_transfer', 'group_message', 'admin_action', 'platform_withdrawal'));

alter table public.ledger_entries drop constraint ledger_entries_reason_check;
alter table public.ledger_entries add constraint ledger_entries_reason_check
  check (reason in (
    'topup_purchase',
    'topup_platform_fee',
    'message_debit',
    'escrow_hold',
    'escrow_release_earning',
    'escrow_release_platform_cut',
    'escrow_refund_unanswered',
    'earnings_conversion',
    'withdrawal_platform_fee',
    'withdrawal_payout',
    'withdrawal_refund_failed',
    'status_upload_debit',
    'manual_adjustment',
    'credit_transfer_sent',
    'credit_transfer_received',
    'credit_transfer_conversion',
    'credit_transfer_platform_cut',
    'group_message_debit',
    'group_message_owner_earning',
    'group_message_platform_cut',
    'platform_reserve_skim',
    'chargeback_debit',
    'chargeback_fee_reversal',
    'platform_earnings_conversion',
    'platform_withdrawal_payout',
    'platform_withdrawal_refund_failed'
  ));

-- =============================================================================
-- fn_admin_initiate_platform_withdrawal — dual-approval-gated (no
-- materiality floor), single-wallet lock on platform_revenue_topup_fees
-- for the target currency. Redeems a 'platform_withdrawal' pending action
-- and verifies the payload matches every argument, same pattern as every
-- other apply-side function in this phase.
-- =============================================================================

create function public.fn_admin_initiate_platform_withdrawal(
  p_actor_admin_id uuid,
  p_pending_action_id uuid,
  p_currency text,
  p_amount_minor bigint,
  p_platform_bank_account_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_bank_active boolean;
  v_bank_currency text;
  v_wallet_id uuid;
  v_balance bigint;
  v_id uuid;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'initiate_platform_withdrawal') then
    raise exception 'not_authorized';
  end if;

  if p_amount_minor <= 0 then
    raise exception 'invalid_amount';
  end if;

  v_payload := public.fn_admin_consume_approved_pending_action(p_pending_action_id, 'platform_withdrawal');

  if v_payload->>'currency' is distinct from p_currency
     or (v_payload->>'amount_minor')::bigint is distinct from p_amount_minor
     or v_payload->>'platform_bank_account_id' is distinct from p_platform_bank_account_id::text
  then
    raise exception 'pending_action_payload_mismatch';
  end if;

  select is_active, currency into v_bank_active, v_bank_currency
    from public.platform_bank_accounts where id = p_platform_bank_account_id;

  if v_bank_active is null then
    raise exception 'bank_account_not_found';
  end if;
  if not v_bank_active then
    raise exception 'bank_account_inactive';
  end if;
  if v_bank_currency is distinct from p_currency then
    raise exception 'bank_account_currency_mismatch: account is % but withdrawal is %', v_bank_currency, p_currency;
  end if;

  select id, balance into v_wallet_id, v_balance from public.wallets
    where kind = 'platform_revenue_topup_fees' and currency = p_currency and user_id is null
    for update;

  if v_wallet_id is null then
    raise exception 'platform_wallet_not_found_for_currency: %', p_currency;
  end if;

  if v_balance < p_amount_minor then
    raise exception 'insufficient_platform_revenue: need % have %', p_amount_minor, v_balance;
  end if;

  insert into public.platform_withdrawals
    (currency, amount_minor, platform_bank_account_id, initiated_by_admin_id, pending_action_id)
  values
    (p_currency, p_amount_minor, p_platform_bank_account_id, p_actor_admin_id, p_pending_action_id)
  returning id into v_id;

  insert into public.ledger_entries (wallet_id, amount, reason, ref_type, ref_id, currency)
  values (v_wallet_id, -p_amount_minor, 'platform_withdrawal_payout', 'platform_withdrawal', v_id, p_currency);

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'initiate_platform_withdrawal',
    'platform_withdrawals',
    v_id::text,
    null,
    jsonb_build_object('currency', p_currency, 'amount_minor', p_amount_minor, 'platform_bank_account_id', p_platform_bank_account_id),
    null
  );

  return v_id;
end;
$$;

revoke execute on function public.fn_admin_initiate_platform_withdrawal(uuid, uuid, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.fn_admin_initiate_platform_withdrawal(uuid, uuid, text, bigint, uuid) to service_role;

-- =============================================================================
-- fn_admin_complete_platform_withdrawal / fn_admin_fail_platform_withdrawal
-- — no actor/permission check, by design: these are only ever called by
-- the webhook handler (piece 3), acting as the system on behalf of
-- Flutterwave's own delivery, exactly like fn_complete_withdrawal/
-- fn_fail_withdrawal today. Idempotent on retry (a webhook redelivering
-- the same event is a real, expected case, not an error).
-- =============================================================================

create function public.fn_admin_complete_platform_withdrawal(
  p_platform_withdrawal_id uuid,
  p_provider_reference text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_withdrawals%rowtype;
begin
  select * into v_row from public.platform_withdrawals where id = p_platform_withdrawal_id for update;
  if not found then
    raise exception 'platform_withdrawal_not_found';
  end if;

  if v_row.status = 'paid' then
    return;
  end if;

  if v_row.status <> 'processing' then
    raise exception 'platform_withdrawal_not_processing: current status is %', v_row.status;
  end if;

  update public.platform_withdrawals
  set status = 'paid', provider_reference = p_provider_reference, completed_at = now()
  where id = p_platform_withdrawal_id;
end;
$$;

revoke execute on function public.fn_admin_complete_platform_withdrawal(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_admin_complete_platform_withdrawal(uuid, text) to service_role;

create function public.fn_admin_fail_platform_withdrawal(p_platform_withdrawal_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.platform_withdrawals%rowtype;
  v_wallet_id uuid;
begin
  select * into v_row from public.platform_withdrawals where id = p_platform_withdrawal_id for update;
  if not found then
    raise exception 'platform_withdrawal_not_found';
  end if;

  if v_row.status = 'failed' then
    return;
  end if;

  if v_row.status <> 'processing' then
    raise exception 'platform_withdrawal_not_processing: current status is %', v_row.status;
  end if;

  select id into v_wallet_id from public.wallets
    where kind = 'platform_revenue_topup_fees' and currency = v_row.currency and user_id is null
    for update;

  update public.platform_withdrawals set status = 'failed' where id = p_platform_withdrawal_id;

  insert into public.ledger_entries (wallet_id, amount, reason, ref_type, ref_id, currency)
  values (v_wallet_id, v_row.amount_minor, 'platform_withdrawal_refund_failed', 'platform_withdrawal', p_platform_withdrawal_id, v_row.currency);
end;
$$;

revoke execute on function public.fn_admin_fail_platform_withdrawal(uuid) from public, anon, authenticated;
grant execute on function public.fn_admin_fail_platform_withdrawal(uuid) to service_role;
