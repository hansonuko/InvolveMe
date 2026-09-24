-- Admin dashboard Phase F piece 1 (docs/14-ADMIN-DASHBOARD-SCOPING.md §5/§9)
-- — platform bank account destinations + the platform-side earnings-to-
-- cash conversion. Nothing in this migration moves money out of the
-- platform yet (that's piece 2's fn_admin_initiate_platform_withdrawal);
-- this is the prerequisite plumbing.
--
-- Two real findings from the pre-build review (confirmed directly, not
-- assumed) shape this migration:
--
--   1. platform_revenue_topup_fees and platform_revenue_earnings_cut are
--      denominated in DIFFERENT units — kobo vs. credits (already on
--      record from Phase B's Treasury piece). §5's wording ("debits
--      platform_revenue_topup_fees/platform_revenue_earnings_cut... by
--      the requested amount") glosses over this: you cannot withdraw "an
--      amount" across two differently-denominated wallets in one
--      function. platform_revenue_topup_fees is already cash and directly
--      withdrawable (piece 2's job); platform_revenue_earnings_cut is
--      credits and needs a conversion step first — the same
--      earnings_pending -> withdrawable_cash shape every user-facing
--      earning already goes through (fn_release_escrow /
--      fn_send_group_message, reason 'earnings_conversion'), which
--      genuinely never existed on the platform side until this migration.
--      fn_admin_convert_platform_earnings_to_cash below is that missing
--      step, reusing 'platform_earnings_conversion' as a single reason
--      value for both entries of the pair — same precedent
--      'earnings_conversion' already sets (one reason, reused for both
--      the debit and the credit side, distinguished by wallet_id/sign,
--      not by two separate reason values).
--   2. This is a genuinely two-wallet operation (earnings_cut wallet debited,
--      topup_fees wallet credited, same currency) — the actual place the
--      fixed-ascending-lock-order pattern (docs/02-DATA-MODEL.md §3,
--      fn_transfer_credit's array-sort-and-loop) belongs in this phase,
--      not fn_initiate_platform_withdrawal itself (piece 2), which only
--      ever touches one wallet per call.
--
-- Registering a NEW platform_bank_accounts row is dual-approval-gated
-- (a new 'platform_bank_account_registration' action_type) — deliberately,
-- not just the withdrawal itself: a single compromised super_admin account
-- could otherwise register an attacker-controlled destination as the
-- enabling step, then (with a second compromised account) withdraw to it.
-- Deactivating an existing destination is single-admin — it only removes a
-- withdrawal option, the opposite risk direction, same asymmetry this
-- codebase already applies elsewhere (freezing a wallet is single-admin
-- and reversible; the action that unlocks new spend is the one that needs
-- the extra gate). fn_admin_convert_platform_earnings_to_cash is also
-- single-admin: it never moves value out of the platform's own wallets,
-- and the exchange rate is pricing_config's own credit_unit_kobo, not
-- something the calling admin controls — nothing about it can be used to
-- fabricate value, only to make already-recognized revenue liquid.

-- =============================================================================
-- New permission — registering/deactivating a payout destination is its
-- own, higher-trust capability, distinct from initiate_platform_withdrawal
-- (which the earnings-conversion function below also reuses, since
-- "making platform revenue withdrawable" is conceptually part of the same
-- treasury-prep capability that permission already names).
-- =============================================================================

insert into public.admin_permissions (name, description) values
  ('manage_platform_bank_accounts', 'Register (dual-approved) or deactivate a platform treasury payout destination')
on conflict (name) do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id from public.admin_roles r, public.admin_permissions p
where r.name = 'super_admin' and p.name = 'manage_platform_bank_accounts'
on conflict do nothing;

-- =============================================================================
-- platform_bank_accounts — company-owned payout destinations only, never a
-- user's. Soft-deactivated, never deleted, same reasoning every other
-- money-adjacent table in this schema uses: the history of what destination
-- a given withdrawal went to must survive the destination itself being
-- retired.
-- =============================================================================

create table public.platform_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  currency text not null default 'NGN',
  bank_name text not null,
  account_number_last4 text not null,
  -- The payment provider's own transfer-recipient id — packages/payments'
  -- initiatePayout(PayoutRequest) takes recipientId, never a raw account
  -- number, same shape bank_accounts.provider_account_id already uses for
  -- user withdrawals.
  provider_account_id text not null,
  account_name text not null,
  label text,
  is_active boolean not null default true,
  added_by_admin_id uuid not null references public.admin_users(id),
  created_at timestamptz not null default now(),
  deactivated_by_admin_id uuid references public.admin_users(id),
  deactivated_at timestamptz
);

create index platform_bank_accounts_active_idx on public.platform_bank_accounts (currency) where is_active;

alter table public.platform_bank_accounts enable row level security;

-- Same posture as admin_pending_actions/admin_audit_log: this project's
-- default ACL grants anon/authenticated/service_role full DML on a
-- freshly created table, so every write here must go through the
-- SECURITY DEFINER functions below.
revoke insert, update, delete on public.platform_bank_accounts from public, anon, authenticated, service_role;
grant select on public.platform_bank_accounts to service_role;

-- =============================================================================
-- action_type widened for the new dual-approved registration flow, and the
-- propose/approve engine's permission mapping (piece 1's
-- fn_admin_pending_action_required_permission) extended to match — same
-- "widen deliberately, in the same migration as what needs it" precedent
-- ledger_entries.reason/ref_type have already been through twice.
-- =============================================================================

alter table public.admin_pending_actions drop constraint admin_pending_actions_action_type_check;
alter table public.admin_pending_actions add constraint admin_pending_actions_action_type_check
  check (action_type in ('pricing_config_update', 'manual_ledger_adjustment', 'platform_bank_account_registration'));

create or replace function public.fn_admin_pending_action_required_permission(p_action_type text)
returns text
language sql
immutable
as $$
  select case p_action_type
    when 'pricing_config_update' then 'edit_pricing_config'
    when 'manual_ledger_adjustment' then 'post_manual_adjustment'
    when 'platform_bank_account_registration' then 'manage_platform_bank_accounts'
    else null
  end;
$$;

-- =============================================================================
-- ledger_entries.reason widened for the conversion pair.
-- =============================================================================

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
    'platform_earnings_conversion'
  ));

-- =============================================================================
-- fn_admin_register_platform_bank_account — the only sanctioned write path
-- to platform_bank_accounts. Redeems a dual-approved
-- 'platform_bank_account_registration' pending action and verifies the
-- consumed payload matches every argument field-for-field, same pattern
-- fn_admin_update_pricing_config / fn_admin_post_manual_adjustment already
-- establish.
-- =============================================================================

create function public.fn_admin_register_platform_bank_account(
  p_actor_admin_id uuid,
  p_pending_action_id uuid,
  p_currency text,
  p_bank_name text,
  p_account_number_last4 text,
  p_provider_account_id text,
  p_account_name text,
  p_label text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_id uuid;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'manage_platform_bank_accounts') then
    raise exception 'not_authorized';
  end if;

  v_payload := public.fn_admin_consume_approved_pending_action(p_pending_action_id, 'platform_bank_account_registration');

  if v_payload->>'currency' is distinct from p_currency
     or v_payload->>'bank_name' is distinct from p_bank_name
     or v_payload->>'account_number_last4' is distinct from p_account_number_last4
     or v_payload->>'provider_account_id' is distinct from p_provider_account_id
     or v_payload->>'account_name' is distinct from p_account_name
     or coalesce(v_payload->>'label', '') is distinct from coalesce(p_label, '')
  then
    raise exception 'pending_action_payload_mismatch';
  end if;

  insert into public.platform_bank_accounts
    (currency, bank_name, account_number_last4, provider_account_id, account_name, label, added_by_admin_id)
  values
    (p_currency, p_bank_name, p_account_number_last4, p_provider_account_id, p_account_name, p_label, p_actor_admin_id)
  returning id into v_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'register_platform_bank_account',
    'platform_bank_accounts',
    v_id::text,
    null,
    jsonb_build_object('currency', p_currency, 'bank_name', p_bank_name, 'account_number_last4', p_account_number_last4),
    null
  );

  return v_id;
end;
$$;

revoke execute on function public.fn_admin_register_platform_bank_account(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_admin_register_platform_bank_account(uuid, uuid, text, text, text, text, text, text) to service_role;

-- =============================================================================
-- fn_admin_deactivate_platform_bank_account — single-admin (see header
-- comment for the asymmetry reasoning).
-- =============================================================================

create function public.fn_admin_deactivate_platform_bank_account(
  p_actor_admin_id uuid,
  p_bank_account_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'manage_platform_bank_accounts') then
    raise exception 'not_authorized';
  end if;

  update public.platform_bank_accounts
  set is_active = false, deactivated_by_admin_id = p_actor_admin_id, deactivated_at = now()
  where id = p_bank_account_id and is_active = true;

  if not found then
    raise exception 'bank_account_not_found_or_already_inactive';
  end if;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'deactivate_platform_bank_account',
    'platform_bank_accounts',
    p_bank_account_id::text,
    jsonb_build_object('is_active', true),
    jsonb_build_object('is_active', false),
    null
  );
end;
$$;

revoke execute on function public.fn_admin_deactivate_platform_bank_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_admin_deactivate_platform_bank_account(uuid, uuid) to service_role;

-- =============================================================================
-- fn_admin_convert_platform_earnings_to_cash — single-admin, gated on
-- initiate_platform_withdrawal (see header comment for why this is safe
-- without dual approval: it can only ever move the platform's own
-- already-recognized revenue between two of its own wallets, at a rate
-- neither admin controls). Genuinely two-wallet, so this is where the
-- fixed-ascending-lock-order pattern (fn_transfer_credit) actually applies
-- in this phase.
-- =============================================================================

create function public.fn_admin_convert_platform_earnings_to_cash(
  p_actor_admin_id uuid,
  p_currency text,
  p_credits bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_earnings_wallet_id uuid;
  v_cash_wallet_id uuid;
  v_wallet_ids uuid[];
  v_wallet_id uuid;
  v_earnings_balance bigint;
  v_unit_kobo bigint;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'initiate_platform_withdrawal') then
    raise exception 'not_authorized';
  end if;

  if p_credits <= 0 then
    raise exception 'invalid_amount';
  end if;

  select id into v_earnings_wallet_id from public.wallets
    where kind = 'platform_revenue_earnings_cut' and currency = p_currency and user_id is null;
  select id into v_cash_wallet_id from public.wallets
    where kind = 'platform_revenue_topup_fees' and currency = p_currency and user_id is null;

  if v_earnings_wallet_id is null or v_cash_wallet_id is null then
    raise exception 'platform_wallet_not_found_for_currency: %', p_currency;
  end if;

  v_wallet_ids := array(select unnest(array[v_earnings_wallet_id, v_cash_wallet_id]) order by 1);
  foreach v_wallet_id in array v_wallet_ids loop
    perform 1 from public.wallets where id = v_wallet_id for update;
  end loop;

  select balance into v_earnings_balance from public.wallets where id = v_earnings_wallet_id;
  if v_earnings_balance < p_credits then
    raise exception 'insufficient_platform_earnings_balance: need % have %', p_credits, v_earnings_balance;
  end if;

  select value into v_unit_kobo from public.pricing_config where key = 'credit_unit_kobo' and currency = p_currency;
  if v_unit_kobo is null then
    raise exception 'credit_unit_kobo_not_configured_for_currency: %', p_currency;
  end if;

  insert into public.ledger_entries (wallet_id, amount, reason, ref_type, currency)
  values (v_earnings_wallet_id, -p_credits, 'platform_earnings_conversion', 'admin_action', p_currency);

  insert into public.ledger_entries (wallet_id, amount, reason, ref_type, currency)
  values (v_cash_wallet_id, p_credits * v_unit_kobo, 'platform_earnings_conversion', 'admin_action', p_currency);

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'convert_platform_earnings_to_cash',
    'wallets',
    v_earnings_wallet_id::text,
    null,
    jsonb_build_object('currency', p_currency, 'credits', p_credits, 'kobo_credited', p_credits * v_unit_kobo),
    null
  );
end;
$$;

revoke execute on function public.fn_admin_convert_platform_earnings_to_cash(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.fn_admin_convert_platform_earnings_to_cash(uuid, text, bigint) to service_role;
