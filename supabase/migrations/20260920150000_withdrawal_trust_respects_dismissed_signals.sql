-- Found while scoping admin dashboard Phase D, checking
-- withdrawal_trust_signal_lookback_days' real behavior: fn_is_withdrawal_
-- trusted (20260915160000_settlement_aware_auto_sweep.sql) disqualifies a
-- payee from trusted (instant-tier) auto-sweep treatment if they have a
-- high-severity fraud_signals row within the lookback window — but it
-- never checked resolved_at, because that column didn't exist yet when
-- this function was written (it was added later, in Phase C piece 1,
-- 20260920140000_admin_reports_fraud_schema.sql). The practical effect:
-- an admin explicitly DISMISSING a signal through the fraud queue built in
-- Phase C has zero effect on this check — the user stays disqualified for
-- the full 90-day window regardless, exactly as if the signal had never
-- been reviewed at all. That directly undercuts the point of building a
-- review queue in the first place.
--
-- Fix: unresolved signals still disqualify (conservative default for
-- anything not yet reviewed, unchanged), escalated signals still
-- disqualify (an admin confirmed it's concerning), but dismissed signals
-- no longer do (an admin confirmed it wasn't real fraud). `create or
-- replace` preserves this function's existing revoke/grant lock
-- automatically — Postgres doesn't reset a function's ACL on REPLACE —
-- confirmed directly after applying this migration, not assumed.
create or replace function public.fn_is_withdrawal_trusted(p_user_id uuid)
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
      and (resolved_at is null or resolution = 'escalated')
  ) into v_has_disqualifying_signal;

  return not v_has_disqualifying_signal;
end;
$$;
