-- Clawback-as-debt (docs/06-SECURITY-FRAUD-LOOPHOLES.md §3, "build now"
-- bullet 4): if a topup is reversed after its credits were already
-- spent/released to a payee, the loss becomes tracked debt on the payer's
-- wallet — never silently absorbed by the platform, never clawed back from
-- an innocent payee who earned in good faith.
--
-- Trigger: fn_process_chargeback is invoked directly via RPC/SQL by
-- whoever handles support/ops when a bank/Flutterwave reversal notice
-- comes in — the same precedent the 'manual_adjustment' ledger reason
-- already establishes for a hand-operated, DB-access-level ledger action,
-- since no admin panel exists in this app yet. It is deliberately NOT
-- wired to any webhook event: webhook-flutterwave/index.ts only ever
-- confirmed charge.completed/transfer.completed against real Flutterwave
-- payloads (see that file's own header comment for the two-day incident
-- that resulted from guessing at an unconfirmed event shape once already),
-- and this app has no card-collection path for a dispute event to exist
-- against in the first place — only NGN bank-transfer/virtual-account
-- collections. If/when a real reversal-notification path is confirmed,
-- wiring it to call this same function is a small follow-up, not a
-- redesign.

alter table public.topups drop constraint topups_status_check;
alter table public.topups add constraint topups_status_check check (
  status in ('pending', 'completed', 'failed', 'reversed')
);

-- =============================================================================
-- fn_process_chargeback — reverses a completed topup's credits and platform
-- fee, tracks the shortfall as a negative balance (debt) on the payer's
-- topup_credit wallet, freezes that wallet until the debt is settled, and
-- logs a fraud_signals row for the review queue. Idempotent: calling it
-- again on an already-reversed topup is a no-op, same
-- lock-then-short-circuit shape fn_confirm_topup already uses.
--
-- Deliberately does not touch the payee's wallets — they keep what they
-- earned in good faith unless collusion with the payer is separately
-- flagged (the existing collusion-detection system's job, not this
-- function's — docs/06 §2/§3).
-- =============================================================================

create function public.fn_process_chargeback(p_topup_id uuid, p_reason text default 'chargeback')
returns table (credits_debited bigint, resulting_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup topups%rowtype;
  v_wallet_id uuid;
  v_platform_wallet_id uuid;
  v_resulting_balance bigint;
begin
  select * into v_topup from topups where id = p_topup_id for update;
  if not found then
    raise exception 'topup_not_found';
  end if;

  if v_topup.status = 'reversed' then
    select w.balance into v_resulting_balance from wallets w
      where w.user_id = v_topup.user_id and w.kind = 'topup_credit';
    return query select 0::bigint, v_resulting_balance;
    return;
  end if;

  if v_topup.status <> 'completed' then
    raise exception 'topup_not_completed: current status is %', v_topup.status;
  end if;

  select id into v_wallet_id from wallets
    where user_id = v_topup.user_id and kind = 'topup_credit'
    for update;

  if v_topup.credits_issued > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_wallet_id, -v_topup.credits_issued, 'chargeback_debit', 'topup', p_topup_id);
  end if;

  if v_topup.platform_fee_kobo > 0 then
    select id into v_platform_wallet_id from wallets
      where kind = 'platform_revenue_topup_fees' and user_id is null
      for update;

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_platform_wallet_id, -v_topup.platform_fee_kobo, 'chargeback_fee_reversal', 'topup', p_topup_id);
  end if;

  update topups set status = 'reversed' where id = p_topup_id;
  update wallets set is_frozen = true where id = v_wallet_id;

  select balance into v_resulting_balance from wallets where id = v_wallet_id;

  insert into fraud_signals (user_id, signal_type, severity, metadata)
  values (
    v_topup.user_id, 'chargeback', 'high',
    jsonb_build_object(
      'topup_id', p_topup_id,
      'credits_clawed_back', v_topup.credits_issued,
      'fee_reversed_kobo', v_topup.platform_fee_kobo,
      'resulting_balance', v_resulting_balance,
      'reason', p_reason
    )
  );

  return query select v_topup.credits_issued, v_resulting_balance;
end;
$$;
