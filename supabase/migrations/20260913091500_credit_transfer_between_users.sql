-- Peer-to-peer credit transfer, convertible to cash on the recipient's
-- side (docs/00-SESSION-HANDOFF.md's "Credit transfer" section has the
-- full context). Flagging this loudly because it is the one feature in
-- this migration that docs/07-COMPLIANCE-LEGAL.md §1 names explicitly as
-- "do not build without a legal check first" — a wallet-to-wallet transfer
-- convertible to cash, unconnected to any chat activity, is exactly the
-- pattern that changes InvolveMe's regulatory classification. This was
-- built anyway on an explicit, informed decision by the product owner
-- after that risk was surfaced (see handoff doc) — it is not an oversight,
-- but it is exactly the kind of change docs/07 §6's pre-launch checklist
-- exists to catch, so it stays on that checklist as an open item.
--
-- Design choices that keep this on the app's *existing* audited rails
-- rather than inventing a second, parallel money-movement path:
--   - The sender's topup_credit is debited exactly like a message spend.
--   - The recipient's credit lands in earnings_pending and is immediately
--     converted to withdrawable_cash, reusing the exact ledger-entry shape
--     fn_release_escrow already uses for a real chat-earned credit (see
--     the guard_frozen_wallets migration) — so it inherits the same
--     KYC-gated, name-matched withdrawal path (CLAUDE.md rule #7) rather
--     than needing its own cash-out logic.
--   - The same platform_earning_take_bps-style cut applies (new, separate
--     config key so it's independently tunable — CLAUDE.md rule #9), so
--     this doesn't become a zero-fee way to move money that a real chat
--     interaction would have taxed.
--   - A conservative per-transfer cap (credit_transfer_max_credits) bounds
--     the blast radius of a bug or an abuse pattern on a brand-new
--     money-moving path with zero production history — cheap insurance,
--     not a substitute for the legal review this still needs.

alter table public.ledger_entries drop constraint ledger_entries_reason_check;
alter table public.ledger_entries add constraint ledger_entries_reason_check check (reason in (
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
  'credit_transfer_platform_cut'
));

alter table public.ledger_entries drop constraint ledger_entries_ref_type_check;
alter table public.ledger_entries add constraint ledger_entries_ref_type_check
  check (ref_type in ('message', 'topup', 'withdrawal', 'escrow', 'status_update', 'credit_transfer'));

create table public.credit_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.users(id),
  recipient_id uuid not null references public.users(id),
  credits_sent bigint not null check (credits_sent > 0),
  platform_cut_credits bigint not null default 0,
  credits_received bigint not null,
  note text,
  created_at timestamptz not null default now()
);

create index credit_transfers_sender_id_idx on public.credit_transfers (sender_id);
create index credit_transfers_recipient_id_idx on public.credit_transfers (recipient_id);

alter table public.credit_transfers enable row level security;

-- Same posture as topups/withdrawals (docs/02-DATA-MODEL.md §2): read your
-- own activity, no client insert/update/delete — every write is via
-- fn_transfer_credit (SECURITY DEFINER), called by the service role only.
create policy credit_transfers_select_own on public.credit_transfers
  for select using (auth.uid() = sender_id or auth.uid() = recipient_id);

insert into public.pricing_config (key, value, description) values
  ('platform_transfer_take_bps', 2000, 'Platform cut on a peer-to-peer credit transfer, in basis points (2000 = 20.00%) — mirrors platform_earning_take_bps by default but independently tunable'),
  ('credit_transfer_max_credits', 1000, 'Hard cap on credits per single transfer (₦10,000 at v1 pricing) — a bug/abuse blast-radius limit, not a product decision; raise deliberately');

-- =============================================================================
-- fn_transfer_credit — debits the sender's topup_credit, credits the
-- recipient's earnings_pending and immediately converts it to
-- withdrawable_cash (see header comment for why this reuses the escrow-
-- release ledger shape instead of a new one). Locks every wallet it
-- touches in a single fixed ascending-id order before touching any of them
-- (docs/02-DATA-MODEL.md §3) — sender and recipient are different users'
-- wallets here, so without this a concurrent A->B and B->A transfer could
-- lock the same two rows in opposite order and deadlock.
-- =============================================================================

create function public.fn_transfer_credit(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_credits bigint,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_max_credits bigint;
  v_sender_wallet_id uuid;
  v_recipient_earnings_wallet_id uuid;
  v_recipient_cash_wallet_id uuid;
  v_platform_wallet_id uuid;
  v_wallet_ids uuid[];
  v_wallet_id uuid;
  v_sender_balance bigint;
  v_sender_frozen boolean;
  v_recipient_earnings_frozen boolean;
  v_recipient_cash_frozen boolean;
  v_sender_suspended boolean;
  v_recipient_suspended boolean;
  v_platform_cut bigint;
  v_payee_amount bigint;
  v_transfer_id uuid;
begin
  if p_credits <= 0 then
    raise exception 'invalid_amount';
  end if;

  if p_sender_id = p_recipient_id then
    raise exception 'cannot_transfer_to_self';
  end if;

  select is_suspended into v_sender_suspended from users where id = p_sender_id;
  if not found then
    raise exception 'sender_not_found';
  end if;
  if v_sender_suspended then
    raise exception 'sender_suspended';
  end if;

  select is_suspended into v_recipient_suspended from users where id = p_recipient_id;
  if not found then
    raise exception 'recipient_not_found';
  end if;
  if v_recipient_suspended then
    raise exception 'recipient_suspended';
  end if;

  select value into v_max_credits from pricing_config where key = 'credit_transfer_max_credits';
  if p_credits > v_max_credits then
    raise exception 'amount_over_transfer_cap: max % have %', v_max_credits, p_credits;
  end if;

  select value into v_take_bps from pricing_config where key = 'platform_transfer_take_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

  select id into v_sender_wallet_id from wallets
    where user_id = p_sender_id and kind = 'topup_credit';
  select id into v_recipient_earnings_wallet_id from wallets
    where user_id = p_recipient_id and kind = 'earnings_pending';
  select id into v_recipient_cash_wallet_id from wallets
    where user_id = p_recipient_id and kind = 'withdrawable_cash';
  select id into v_platform_wallet_id from wallets
    where kind = 'platform_revenue_earnings_cut' and user_id is null;

  v_wallet_ids := array(
    select unnest(array[
      v_sender_wallet_id, v_recipient_earnings_wallet_id, v_recipient_cash_wallet_id, v_platform_wallet_id
    ]) order by 1
  );

  foreach v_wallet_id in array v_wallet_ids loop
    perform 1 from wallets where id = v_wallet_id for update;
  end loop;

  select balance, is_frozen into v_sender_balance, v_sender_frozen
    from wallets where id = v_sender_wallet_id;
  select is_frozen into v_recipient_earnings_frozen
    from wallets where id = v_recipient_earnings_wallet_id;
  select is_frozen into v_recipient_cash_frozen
    from wallets where id = v_recipient_cash_wallet_id;

  if v_sender_frozen or v_recipient_earnings_frozen or v_recipient_cash_frozen then
    raise exception 'wallet_frozen';
  end if;

  if v_sender_balance < p_credits then
    raise exception 'insufficient_credit: need % have %', p_credits, v_sender_balance;
  end if;

  v_platform_cut := round(p_credits::numeric * v_take_bps / 10000)::bigint;
  v_payee_amount := p_credits - v_platform_cut;

  insert into credit_transfers (sender_id, recipient_id, credits_sent, platform_cut_credits, credits_received, note)
  values (p_sender_id, p_recipient_id, p_credits, v_platform_cut, v_payee_amount, p_note)
  returning id into v_transfer_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_sender_wallet_id, -p_credits, 'credit_transfer_sent', 'credit_transfer', v_transfer_id);

  if v_payee_amount > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_recipient_earnings_wallet_id, v_payee_amount, 'credit_transfer_received', 'credit_transfer', v_transfer_id);

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_recipient_earnings_wallet_id, -v_payee_amount, 'credit_transfer_conversion', 'credit_transfer', v_transfer_id);

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_recipient_cash_wallet_id, v_payee_amount * v_unit_kobo, 'credit_transfer_conversion', 'credit_transfer', v_transfer_id);
  end if;

  if v_platform_cut > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_platform_wallet_id, v_platform_cut, 'credit_transfer_platform_cut', 'credit_transfer', v_transfer_id);
  end if;

  return v_transfer_id;
end;
$$;

revoke execute on function public.fn_transfer_credit(uuid, uuid, bigint, text) from public;
grant execute on function public.fn_transfer_credit(uuid, uuid, bigint, text) to service_role;

alter publication supabase_realtime add table public.credit_transfers;
