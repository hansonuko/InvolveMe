-- Phase 2 batch 2 (webhook-flutterwave, withdraw) — two pieces of
-- "necessary connective tissue" neither docs/02-DATA-MODEL.md nor the item-3
-- function set anticipated, discovered while building against Flutterwave's
-- actual current API (docs/05-API-REALTIME-SPEC.md's webhook section was
-- written against an older assumption and is updated alongside this
-- migration — see that doc's webhook-flutterwave section for what changed
-- and why).
--
-- =============================================================================
-- webhook_events_seen — idempotency ledger for inbound provider webhooks,
-- per docs/06-SECURITY-FRAUD-LOOPHOLES.md §9 and CLAUDE.md rule #6
-- ("webhook handlers are idempotent and signature-verified, full stop").
--
-- This is the fast-path guard, not the actual correctness guarantee: even
-- if two genuinely concurrent deliveries of the same event both raced past
-- this table (vanishingly unlikely given the unique constraint below is
-- itself atomic, but worth being honest about), fn_confirm_topup and
-- fn_complete_withdrawal are independently idempotent via their own status
-- checks under row-level locking — the same defense-in-depth CLAUDE.md rule
-- #3/#4 already establish for every balance mutation. This table exists so
-- the common case never reprocesses at all, and doubles as an audit trail
-- for the nightly settlement-reconciliation job docs/06 §9 describes
-- (not built yet — needs the provider's settlement-report API, deferred
-- same as everything else that needs live Flutterwave access).
--
-- Claimed via upsert-with-ignoreDuplicates (`on conflict do nothing`) from
-- the Edge Function: an empty result means "already seen, skip"; a
-- returned row means "first time, go process it." No SECURITY DEFINER
-- function needed for this — service_role already reads/writes any table
-- with RLS bypassed, same as every other Edge-Function-only table.
-- =============================================================================

create table public.webhook_events_seen (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('flutterwave', 'paystack')),
  provider_event_id text not null,
  event_type text,
  received_at timestamptz not null default now(),
  constraint webhook_events_seen_provider_event_unique unique (provider, provider_event_id)
);

create index webhook_events_seen_received_at_idx on public.webhook_events_seen (received_at);

alter table public.webhook_events_seen enable row level security;
-- No policies: deny-by-default for anon/authenticated, same posture as
-- every other table per the item-2 RLS migration's header comment.
-- service_role (the only caller — this table is never read by the app)
-- bypasses RLS as normal.

-- =============================================================================
-- fn_complete_withdrawal — marks a withdrawal 'paid' once Flutterwave's
-- transfer-completed webhook confirms the payout actually landed. Not a
-- balance mutation (fn_initiate_withdrawal already debited
-- withdrawable_cash up front, per its own header comment) — this is a pure
-- status transition, but implemented the same way as every other
-- state-changing money-adjacent function (SECURITY DEFINER, service_role
-- only, idempotent on retry) rather than left as inline Edge Function
-- logic, so the withdrawals state machine stays centralized in one place
-- instead of split between SQL and Deno.
--
-- Idempotent the same way fn_confirm_topup is: re-confirming an
-- already-paid withdrawal is a no-op, so a retried/duplicate webhook can't
-- error or double-process.
-- =============================================================================

create function public.fn_complete_withdrawal(p_withdrawal_id uuid, p_provider_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_withdrawal withdrawals%rowtype;
begin
  select * into v_withdrawal from withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'withdrawal_not_found';
  end if;

  if v_withdrawal.status = 'paid' then
    return; -- idempotent no-op on webhook retry
  end if;

  if v_withdrawal.status <> 'processing' then
    raise exception 'withdrawal_not_processing: current status is %', v_withdrawal.status;
  end if;

  update withdrawals set status = 'paid', provider_ref = p_provider_ref where id = p_withdrawal_id;
end;
$$;

revoke execute on function public.fn_complete_withdrawal(uuid, text) from public;
grant execute on function public.fn_complete_withdrawal(uuid, text) to service_role;
