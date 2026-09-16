-- fn_get_withdrawal_countdown (Phase 6, docs/08-BUILD-PHASES-ROADMAP.md line
-- 56 — "withdrawal countdown ring"). Surfaces the timing the settlement-aware
-- auto-sweep (20260915160000_settlement_aware_auto_sweep.sql) already
-- enforces server-side, so the wallet tab can render a real countdown instead
-- of an invented one.
--
-- Deliberately returns only the two numbers the sweep clock actually differs
-- by, not the underlying diagnosis: this app has no self-serve
-- dispute/unfreeze path, and fn_is_withdrawal_trusted's "trusted" boolean is
-- itself derived in part from fraud_signals, which has no RLS policy at all
-- (fully internal) — a client-facing "you are untrusted" field would leak
-- more than this feature needs to show a ring. force_sweep_below_minimum
-- communicates the *effect* (will a below-minimum balance still get swept
-- eventually, yes/no) without naming the cause.
--
-- Does not return wallet.updated_at, withdrawal_min_kobo, or
-- withdrawal_force_sweep_days — all three are already directly readable by
-- the client today (wallets row-level RLS; pricing_config is fully
-- authenticated-readable), so re-deriving them through this RPC would only
-- add a slower path to data the client already has.

create function public.fn_get_withdrawal_countdown(p_user_id uuid)
returns table (
  effective_sweep_hours bigint,
  force_sweep_below_minimum boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sweep_hours bigint;
  v_sweep_hours_untrusted bigint;
  v_trusted boolean;
begin
  select value into v_sweep_hours from pricing_config where key = 'withdrawal_auto_sweep_hours';
  select value into v_sweep_hours_untrusted from pricing_config where key = 'withdrawal_auto_sweep_hours_untrusted';
  v_trusted := fn_is_withdrawal_trusted(p_user_id);

  return query select
    case when v_trusted then v_sweep_hours else v_sweep_hours_untrusted end,
    v_trusted;
end;
$$;

revoke execute on function public.fn_get_withdrawal_countdown(uuid) from public, anon, authenticated;
grant execute on function public.fn_get_withdrawal_countdown(uuid) to service_role;
