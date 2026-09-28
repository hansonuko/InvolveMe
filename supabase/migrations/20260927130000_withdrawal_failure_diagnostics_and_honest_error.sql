-- Withdrawal hardening (docs/00-SESSION-HANDOFF.md — "no real bank transfer
-- or real payout has actually completed" is still true; the user reports
-- every withdrawal attempt fails with "could not be processed right now,
-- your balance has not been debited"). Investigation confirmed the debit/
-- payout/compensating-reversal transaction shape itself is correct and
-- ledger-safe, deployment and Flutterwave credentials all check out live —
-- the actual rejection reason from Flutterwave was never captured anywhere
-- queryable, only `console.error`'d into Edge Function logs this project
-- has no working access path to read back (same class of gap as the
-- deployed-function-testing lesson on record). Two real, fixable gaps this
-- migration closes regardless of what that underlying provider-side reason
-- turns out to be:
--
--   1. No diagnostic trail. `fn_fail_withdrawal` discarded whatever
--      Flutterwave actually said. `withdrawals.failure_reason` now stores
--      it, so the next failure is queryable with a plain SELECT instead of
--      needing log access that has repeatedly not been available.
--
--   2. A false claim on the one path where it actually mattered. If
--      `fn_fail_withdrawal` itself ever fails after a provider error (the
--      existing code's own comment calls this "the debit may be
--      stranded"), the Edge Function still told the user "your balance has
--      not been debited" — which in that specific case is not
--      code-guaranteed to be true. Fixed: that path now marks the
--      withdrawal `held_for_review` (a status this schema has had since
--      day one but never actually used) via a direct update — not routed
--      back through fn_fail_withdrawal, which is the thing that just
--      failed — and returns a distinct, honest message instead of
--      repeating the reversal-succeeded claim.

alter table public.withdrawals add column failure_reason text;

create or replace function public.fn_fail_withdrawal(p_withdrawal_id uuid, p_failure_reason text default null)
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

  update withdrawals set status = 'failed', failure_reason = p_failure_reason where id = p_withdrawal_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_wallet_id, v_withdrawal.amount_kobo, 'withdrawal_refund_failed', 'withdrawal', p_withdrawal_id);
end;
$$;

revoke execute on function public.fn_fail_withdrawal(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_fail_withdrawal(uuid, text) to service_role;

-- The old 1-arg signature is superseded, not just shadowed — drop it so
-- there's no stale overload a future caller could accidentally still hit
-- (Postgres allows both signatures to coexist otherwise).
drop function if exists public.fn_fail_withdrawal(uuid);
