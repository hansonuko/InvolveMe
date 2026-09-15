-- Settlement-aware auto-withdrawal holds (docs/06-SECURITY-FRAUD-LOOPHOLES.md
-- §3's last unbuilt bullet, closing it out) — turns §4's own aspirational
-- table ("Tier 1: auto-sweep subject to collusion checks running before each
-- sweep" vs "Tier 2: instant") into enforced behavior.
--
-- kyc_tier = 2 ("enhanced/liveness KYC") is never assigned anywhere in this
-- codebase (grepped) — no vendor integration for it exists, so waiting for a
-- real Tier 2 isn't buildable today. The actual fix doesn't need one: §4's
-- own Tier 2 definition is "Tier 1 + 30 days clean history" — both pieces
-- (account age, clean fraud-signal history) already exist as data. This
-- computes that distinction as a "trusted" boolean layered on top of
-- existing Tier-1 KYC, rather than waiting on a new KYC tier.
--
-- Scope: auto-sweep only, matching §4's table exactly (the "auto-sweep
-- eligible" column is the only place tiers differ on withdrawal behavior).
-- fn_initiate_withdrawal (manual withdrawal) is untouched — Tier-1 manual
-- withdrawal keeps working at its existing daily cap regardless of trust.
--
-- A disqualifying signal HOLDS the sweep for that payee (their money isn't
-- force-paid that cycle) — it does not freeze their wallet. Auto-freezing
-- on a fraud signal was explicitly rejected as a design decision in an
-- earlier session (fraud signals are logged for manual review only, never
-- auto-freeze — no self-serve unfreeze path exists in this app). Staying
-- consistent with that: this only ever delays a payout, never blocks one
-- outright or touches is_frozen.

-- Gap found while touching this area: fn_credit_platform_revenue
-- (20260915150000_platform_reserve_buffer.sql) is SECURITY DEFINER and
-- money-moving but was never locked down to service_role like every
-- sibling function in this codebase (fn_confirm_topup, fn_release_escrow,
-- fn_send_message, etc. all explicitly revoke from public) — left at the
-- default PUBLIC execute grant, callable directly by any authenticated
-- role to arbitrarily credit the platform's own wallets. Fixed forward
-- here rather than hand-editing the already-applied migration.
-- from anon, authenticated, public — not just public, which is a no-op on
-- this Supabase project (see 20260915161500_lock_security_definer_execute_grants.sql
-- for why: a project-level default-privileges rule grants anon/authenticated
-- EXECUTE directly at CREATE FUNCTION time, a separate grant path PUBLIC-only
-- revocation never touches).
revoke execute on function public.fn_credit_platform_revenue(text, text, bigint, text, text, uuid) from anon, authenticated, public;
grant execute on function public.fn_credit_platform_revenue(text, text, bigint, text, text, uuid) to service_role;

-- Same gap, more serious: fn_process_chargeback
-- (20260915151500_chargeback_clawback.sql) is the ops-only clawback
-- trigger — meant to be invoked only via service-role access, never by an
-- app user. Left at the default PUBLIC grant, any authenticated user
-- could have called it directly against ANY topup id (their own or
-- someone else's), reversing and freezing an arbitrary payer's wallet.
-- Fixed forward for the same reason as above.
revoke execute on function public.fn_process_chargeback(uuid, text) from anon, authenticated, public;
grant execute on function public.fn_process_chargeback(uuid, text) to service_role;

insert into public.pricing_config (key, value, description) values
  ('withdrawal_auto_sweep_hours_untrusted', 72, 'Hours before an untrusted (fresh and/or recently-flagged) Tier-1 payee''s auto-sweep fires, instead of the normal withdrawal_auto_sweep_hours — docs/06-SECURITY-FRAUD-LOOPHOLES.md §3/§4'),
  ('withdrawal_trust_signal_lookback_days', 90, 'A high-severity fraud_signals row against a payee within this many days disqualifies them from "trusted" (instant-tier) auto-sweep treatment — a rolling window, not a lifetime ban, since there is no admin UI to mark a signal cleared')
on conflict (key) do nothing;

update public.pricing_config
set description = 'How long an account counts as "new" for velocity-limit purposes (topup caps, docs/06 §4) AND for auto-withdrawal trust purposes (docs/06 §3/§4) — the same "how long counts as new" concept, not two separate ones'
where key = 'new_account_age_days';

-- =============================================================================
-- fn_is_withdrawal_trusted — the Tier-1-vs-"trusted" (Tier-2-equivalent)
-- distinction docs/06 §4 already describes. Only ever consulted by the
-- auto-sweep job below; fn_initiate_withdrawal does not call this.
-- =============================================================================

create function public.fn_is_withdrawal_trusted(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kyc_tier smallint;
  v_created_at timestamptz;
  v_age_days bigint;
  v_lookback_days bigint;
  v_has_disqualifying_signal boolean;
begin
  select kyc_tier, created_at into v_kyc_tier, v_created_at from users where id = p_user_id;
  if v_kyc_tier is null or v_kyc_tier < 1 then
    return false;
  end if;

  select value into v_age_days from pricing_config where key = 'new_account_age_days';
  if v_created_at > now() - make_interval(days => v_age_days::integer) then
    return false;
  end if;

  select value into v_lookback_days from pricing_config where key = 'withdrawal_trust_signal_lookback_days';
  select exists (
    select 1 from fraud_signals
    where user_id = p_user_id
      and severity = 'high'
      and created_at > now() - make_interval(days => v_lookback_days::integer)
  ) into v_has_disqualifying_signal;

  return not v_has_disqualifying_signal;
end;
$$;

revoke execute on function public.fn_is_withdrawal_trusted(uuid) from anon, authenticated, public;
grant execute on function public.fn_is_withdrawal_trusted(uuid) to service_role;

-- =============================================================================
-- fn_run_auto_withdraw_sweep — redefined to gate timing on trust. Full body
-- restated per this project's forward-migration convention.
-- =============================================================================

create or replace function public.fn_run_auto_withdraw_sweep()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sweep_hours bigint;
  v_sweep_hours_untrusted bigint;
  v_force_days bigint;
  v_min_kobo bigint;
  v_row record;
  v_trusted boolean;
  v_effective_sweep_hours bigint;
  v_swept_count integer := 0;
begin
  select value into v_sweep_hours from pricing_config where key = 'withdrawal_auto_sweep_hours';
  select value into v_sweep_hours_untrusted from pricing_config where key = 'withdrawal_auto_sweep_hours_untrusted';
  select value into v_force_days from pricing_config where key = 'withdrawal_force_sweep_days';
  select value into v_min_kobo from pricing_config where key = 'withdrawal_min_kobo';

  for v_row in
    select w.user_id, w.balance, w.updated_at, ba.id as bank_account_id
    from wallets w
    join bank_accounts ba on ba.user_id = w.user_id and ba.name_match_verified = true
    where w.kind = 'withdrawable_cash'
      and w.balance > 0
      and not w.is_frozen
      and w.updated_at < now() - make_interval(hours => least(v_sweep_hours, v_sweep_hours_untrusted)::integer)
  loop
    begin
      v_trusted := fn_is_withdrawal_trusted(v_row.user_id);
      v_effective_sweep_hours := case when v_trusted then v_sweep_hours else v_sweep_hours_untrusted end;

      if v_row.updated_at >= now() - make_interval(hours => v_effective_sweep_hours::integer) then
        -- Hasn't aged past this payee's effective threshold yet — leave it.
        continue;
      end if;

      if not v_trusted then
        -- Untrusted (fresh and/or recently high-severity-flagged): never
        -- force-sweep past the minimum-balance floor while still
        -- untrusted, however long it's been sitting — held, not
        -- force-paid, same "hold and notify" posture the bank-account
        -- exclusion above already uses. They're picked up normally once
        -- they age into trusted (the signal ages out of the lookback
        -- window, or the account simply gets older).
        if v_row.balance >= v_min_kobo then
          perform fn_initiate_withdrawal(v_row.user_id, v_row.bank_account_id, null, false);
          v_swept_count := v_swept_count + 1;
        end if;
      elsif v_row.updated_at < now() - make_interval(days => v_force_days::integer) then
        -- Trusted and past the force-sweep window: pay out regardless of
        -- the minimum, exactly as before this migration.
        perform fn_initiate_withdrawal(v_row.user_id, v_row.bank_account_id, null, true);
        v_swept_count := v_swept_count + 1;
      elsif v_row.balance >= v_min_kobo then
        perform fn_initiate_withdrawal(v_row.user_id, v_row.bank_account_id, null, false);
        v_swept_count := v_swept_count + 1;
      end if;
    exception when others then
      insert into fraud_signals (user_id, signal_type, severity, metadata)
      values (v_row.user_id, 'auto_sweep_failed', 'medium', jsonb_build_object('error', sqlerrm));
    end;
  end loop;

  return v_swept_count;
end;
$$;
