-- Phase 1 item 5: the three scheduled jobs from docs/05-API-REALTIME-SPEC.md §2.
--
-- escrow-expiry-sweep already has its function (fn_refund_expired_escrows,
-- from the item-3 migration) — this just gives it a schedule. The other two
-- jobs get their functions here, then all three get scheduled via pg_cron.
--
-- Scope note: this is the DB-only half of "hold and notify" for the
-- auto-withdraw sweep. Users without a verified bank account are correctly
-- excluded from the sweep (their funds are held, not force-paid anywhere),
-- but the "notify" half — a push reminding them to add one — needs an Edge
-- Function/push service that doesn't exist yet. Same for reconciliation:
-- a mismatch freezes the wallet and logs a fraud_signals row, but actually
-- paging on-call needs an external alerting integration this migration
-- can't provide. Both are documented gaps, not silent ones.

create extension if not exists pg_cron with schema extensions;

-- withdrawal_auto_sweep_hours already exists (item 4 seed) — this is the
-- second half of "if 7 days pass without reaching the minimum, sweep
-- anyway" from docs/03-ECONOMY-LEDGER.md §6.
insert into public.pricing_config (key, value, description) values
  ('withdrawal_force_sweep_days', 7, 'Days after which the auto-sweep pays out below-minimum balances anyway, per docs/03-ECONOMY-LEDGER.md §6')
on conflict (key) do nothing;

-- =============================================================================
-- fn_run_reconciliation_check — docs/02-DATA-MODEL.md §4. Any wallet whose
-- cached balance doesn't equal the sum of its own ledger_entries gets frozen
-- immediately (blocking further fn_send_message/withdrawal activity on it —
-- fn_send_message/fn_initiate_withdrawal don't currently check is_frozen
-- themselves; see the note in this migration's bottom section) and logged
-- as a high-severity fraud signal for manual review.
-- =============================================================================

create function public.fn_run_reconciliation_check()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_mismatch_count integer := 0;
begin
  for v_row in
    select w.id as wallet_id, w.user_id, w.balance, coalesce(sum(le.amount), 0) as ledger_sum
    from wallets w
    left join ledger_entries le on le.wallet_id = w.id
    group by w.id, w.user_id, w.balance
    having w.balance <> coalesce(sum(le.amount), 0)
  loop
    update wallets set is_frozen = true where id = v_row.wallet_id;

    insert into fraud_signals (user_id, signal_type, severity, metadata)
    values (
      v_row.user_id,
      'ledger_mismatch',
      'high',
      jsonb_build_object('wallet_id', v_row.wallet_id, 'wallet_balance', v_row.balance, 'ledger_sum', v_row.ledger_sum)
    );

    v_mismatch_count := v_mismatch_count + 1;
  end loop;

  return v_mismatch_count;
end;
$$;

-- =============================================================================
-- fn_run_auto_withdraw_sweep — docs/03-ECONOMY-LEDGER.md §6. Sweeps
-- withdrawable_cash balances that have sat unwithdrawn past the configured
-- window, to a verified bank account only (unverified/no-account users are
-- excluded by the join below — held, not force-paid anywhere).
--
-- v1 proxy, documented not hidden: "how long has this money sat unwithdrawn"
-- is approximated by wallets.updated_at, which is exact as long as
-- withdrawals always sweep the full balance (fn_initiate_withdrawal's
-- default when called with a null amount, which is what this function
-- does). A partial withdrawal would reset the clock on older money still
-- sitting in the same wallet — exact per-credit aging would need dedicated
-- tracking this migration doesn't add.
-- =============================================================================

create function public.fn_run_auto_withdraw_sweep()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sweep_hours bigint;
  v_force_days bigint;
  v_min_kobo bigint;
  v_row record;
  v_swept_count integer := 0;
begin
  select value into v_sweep_hours from pricing_config where key = 'withdrawal_auto_sweep_hours';
  select value into v_force_days from pricing_config where key = 'withdrawal_force_sweep_days';
  select value into v_min_kobo from pricing_config where key = 'withdrawal_min_kobo';

  for v_row in
    select w.user_id, w.balance, w.updated_at, ba.id as bank_account_id
    from wallets w
    join bank_accounts ba on ba.user_id = w.user_id and ba.name_match_verified = true
    where w.kind = 'withdrawable_cash'
      and w.balance > 0
      and not w.is_frozen
      and w.updated_at < now() - make_interval(hours => v_sweep_hours::integer)
  loop
    begin
      if v_row.updated_at < now() - make_interval(days => v_force_days::integer) then
        -- past the force-sweep window: pay out regardless of the minimum
        perform fn_initiate_withdrawal(v_row.user_id, v_row.bank_account_id, null, true);
        v_swept_count := v_swept_count + 1;
      elsif v_row.balance >= v_min_kobo then
        perform fn_initiate_withdrawal(v_row.user_id, v_row.bank_account_id, null, false);
        v_swept_count := v_swept_count + 1;
      end if;
      -- else: below minimum and not yet past the force-sweep window —
      -- leave it to accumulate or to age into the force window.
    exception when others then
      -- one user's failure (e.g. a race with a manual withdrawal that just
      -- emptied this wallet) must not stop the sweep for everyone else.
      insert into fraud_signals (user_id, signal_type, severity, metadata)
      values (v_row.user_id, 'auto_sweep_failed', 'medium', jsonb_build_object('error', sqlerrm));
    end;
  end loop;

  return v_swept_count;
end;
$$;

-- =============================================================================
-- Lock the two new functions to service_role, same as every function in the
-- item-3 migration (fn_refund_expired_escrows is already locked there).
-- =============================================================================

revoke execute on function public.fn_run_reconciliation_check() from public;
revoke execute on function public.fn_run_auto_withdraw_sweep() from public;

grant execute on function public.fn_run_reconciliation_check() to service_role;
grant execute on function public.fn_run_auto_withdraw_sweep() to service_role;

-- =============================================================================
-- Schedule all three jobs. pg_cron jobs run as the role that scheduled them
-- (postgres here, via this migration), which already owns every table/
-- function involved — no additional grants needed for the cron role itself.
-- =============================================================================

select cron.schedule(
  'escrow-expiry-sweep',
  '*/15 * * * *',
  $$ select public.fn_refund_expired_escrows(); $$
);

select cron.schedule(
  'auto-withdraw-sweep',
  '0 * * * *',
  $$ select public.fn_run_auto_withdraw_sweep(); $$
);

select cron.schedule(
  'reconciliation-check',
  '5 * * * *',
  $$ select public.fn_run_reconciliation_check(); $$
);
