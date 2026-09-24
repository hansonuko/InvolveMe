-- Admin dashboard Phase G piece 2 (docs/14-ADMIN-DASHBOARD-SCOPING.md §8,
-- real gap found separately from §8's own list) — the admins list/
-- management page has never existed. Only /dashboard/admins/new (create)
-- does. Two real gaps closed here:
--
-- 1. admin_users.disabled_at is fully wired into login gating already
--    (fn_admin_record_login_attempt's row-lock check + lib/auth.ts's
--    session-validation check both read it) but nothing has ever existed
--    to SET it — the same "checked everywhere, set nowhere" shape prior
--    sessions have found in this codebase before.
-- 2. fn_admin_reset_mfa has existed since Phase A (20260920111500) with
--    zero UI ever wired to it — a real, ready-to-use recovery path that
--    has simply never been reachable from the dashboard.
--
-- docs/14 §4.4 explicitly names "disabling another admin" as one of the
-- materially risky actions requiring dual approval, on record since the
-- original scoping pass — so account-status changes go through
-- admin_pending_actions, same as pricing/treasury changes. Reactivating
-- isn't named in that list, but the same threat model applies in reverse
-- (a compromised manage_admin_roles holder reinstating a previously
-- disabled/off-boarded account is exactly as dangerous as one locking out
-- a legitimate admin to consolidate control) — this migration extends
-- dual-approval to both directions of the toggle, a deliberate reasoned
-- extension of the doc's literal wording, not a narrower reading of it.
--
-- Role (re)assignment is NOT given the same treatment: only manage_admin_
-- roles itself gates it (today, only super_admin holds that permission),
-- matching the doc's materiality list, which names disabling specifically
-- and nothing else in this area. Self-target is still blocked on both new
-- functions — an admin can never change their own account status or their
-- own roles, only a different admin with the permission can, same
-- self-action-blocked posture as fn_admin_reset_mfa and
-- fn_admin_approve_pending_action already established.

-- =============================================================================
-- Widen admin_pending_actions.action_type + the required-permission mapping
-- =============================================================================

alter table public.admin_pending_actions drop constraint admin_pending_actions_action_type_check;
alter table public.admin_pending_actions add constraint admin_pending_actions_action_type_check
  check (action_type in (
    'pricing_config_update',
    'manual_ledger_adjustment',
    'platform_bank_account_registration',
    'platform_withdrawal',
    'message_pricing_strategy_change',
    'admin_account_status_change'
  ));

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
    when 'message_pricing_strategy_change' then 'edit_pricing_config'
    when 'admin_account_status_change' then 'manage_admin_roles'
    else null
  end;
$$;

-- =============================================================================
-- fn_admin_set_admin_account_status — the only sanctioned write path to
-- admin_users.disabled_at. Redeems an approved
-- 'admin_account_status_change' pending action and verifies the consumed
-- payload matches every argument, same guard shape every other dual-
-- approval consuming function in this codebase already uses.
-- =============================================================================

create function public.fn_admin_set_admin_account_status(
  p_actor_admin_id uuid,
  p_pending_action_id uuid,
  p_target_admin_id uuid,
  p_disable boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_prev_disabled_at timestamptz;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'manage_admin_roles') then
    raise exception 'not_authorized';
  end if;

  v_payload := public.fn_admin_consume_approved_pending_action(p_pending_action_id, 'admin_account_status_change');

  if v_payload->>'target_admin_id' is distinct from p_target_admin_id::text
     or (v_payload->>'disable')::boolean is distinct from p_disable
  then
    raise exception 'pending_action_payload_mismatch';
  end if;

  select disabled_at into v_prev_disabled_at
  from public.admin_users
  where id = p_target_admin_id
  for update;

  if not found then
    raise exception 'admin_user_not_found';
  end if;

  update public.admin_users
  set disabled_at = case when p_disable then now() else null end
  where id = p_target_admin_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    case when p_disable then 'admin_account_disabled' else 'admin_account_reactivated' end,
    'admin_users',
    p_target_admin_id::text,
    jsonb_build_object('disabled_at', v_prev_disabled_at),
    jsonb_build_object('disabled_at', case when p_disable then now() else null end),
    null
  );
end;
$$;

revoke execute on function public.fn_admin_set_admin_account_status(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_admin_set_admin_account_status(uuid, uuid, uuid, boolean) to service_role;

-- =============================================================================
-- fn_admin_set_admin_roles — replaces a target admin's full role set
-- atomically (not dual-approval-gated — see header comment for why this
-- one stays matching docs/14 §4.4's literal materiality list). Row-locks
-- the target's admin_users row first so two concurrent role-set calls on
-- the same admin serialize rather than interleaving their delete+insert,
-- same discipline every wallet-touching function in this codebase already
-- uses for its own row locks.
-- =============================================================================

create function public.fn_admin_set_admin_roles(
  p_actor_admin_id uuid,
  p_target_admin_id uuid,
  p_role_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_count int;
  v_prev_role_ids uuid[];
begin
  if p_actor_admin_id = p_target_admin_id then
    raise exception 'cannot_change_own_roles';
  end if;

  if not public.fn_admin_check_permission(p_actor_admin_id, 'manage_admin_roles') then
    raise exception 'not_authorized';
  end if;

  perform 1 from public.admin_users where id = p_target_admin_id for update;
  if not found then
    raise exception 'admin_user_not_found';
  end if;

  select count(*) into v_role_count from public.admin_roles where id = any(p_role_ids);
  if v_role_count <> coalesce(array_length(p_role_ids, 1), 0) then
    raise exception 'invalid_role_id';
  end if;

  select coalesce(array_agg(role_id), '{}') into v_prev_role_ids
  from public.admin_user_roles where admin_user_id = p_target_admin_id;

  delete from public.admin_user_roles where admin_user_id = p_target_admin_id;

  insert into public.admin_user_roles (admin_user_id, role_id)
  select p_target_admin_id, r_id from unnest(p_role_ids) as r_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'admin_roles_changed',
    'admin_users',
    p_target_admin_id::text,
    jsonb_build_object('role_ids', v_prev_role_ids),
    jsonb_build_object('role_ids', p_role_ids),
    null
  );
end;
$$;

revoke execute on function public.fn_admin_set_admin_roles(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.fn_admin_set_admin_roles(uuid, uuid, uuid[]) to service_role;
