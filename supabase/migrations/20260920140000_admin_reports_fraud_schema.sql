-- Admin dashboard Phase C piece 1 (docs/14-ADMIN-DASHBOARD-SCOPING.md §6/§9)
-- — reports & fraud review queue: schema + the actual admin actions.
--
-- Two real gaps found before writing any UI (confirmed directly, not
-- assumed):
--   1. `is_frozen` (wallets) and `is_suspended` (users) are completely
--      virgin — grepped every migration, nothing anywhere has ever set
--      either from an admin action. 20260915093000_collusion_detection.sql
--      says so explicitly in its own header: "this app has no admin UI...
--      this job NEVER sets is_frozen itself." This migration's functions
--      are the first admin-triggerable freeze/suspend code paths that
--      have ever existed in this codebase.
--   2. Neither fraud_signals nor user_reports has any resolution-tracking
--      column — no status, no resolved_by/resolved_at. Without these a
--      "queue" just accumulates forever with no way to mark anything
--      handled, so this is a real schema gap, not just a UI one.

alter table public.fraud_signals
  add column resolved_at timestamptz,
  add column resolved_by uuid references public.admin_users(id),
  add column resolution text check (resolution in ('dismissed', 'escalated')),
  add column resolution_note text;

create index fraud_signals_unresolved_idx on public.fraud_signals (created_at desc) where resolved_at is null;

alter table public.user_reports
  add column resolved_at timestamptz,
  add column resolved_by uuid references public.admin_users(id),
  add column resolution text check (resolution in ('warned', 'suspended', 'banned', 'dismissed')),
  add column resolution_note text;

create index user_reports_unresolved_idx on public.user_reports (created_at desc) where resolved_at is null;

-- =============================================================================
-- resolve_user_report — a second permission distinct from resolve_fraud_
-- signal. docs/14 §4.1's own role table gives support_agent the ability to
-- resolve user_reports but explicitly NOT fraud_signals ("cannot freeze
-- wallets or touch money") — one shared permission can't express that
-- split, so this closes the gap rather than reusing resolve_fraud_signal
-- for both.
-- =============================================================================

insert into public.admin_permissions (name, description) values
  ('resolve_user_report', 'Resolve a user_reports row (warn/suspend/ban/dismiss) — does not include resolve_fraud_signal''s wallet-freeze ability')
on conflict (name) do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id from public.admin_roles r, public.admin_permissions p
where r.name in ('super_admin', 'compliance_officer', 'support_agent')
  and p.name = 'resolve_user_report'
on conflict do nothing;

-- =============================================================================
-- fn_admin_set_wallet_frozen — the first-ever admin-triggerable freeze.
-- Every spend/withdraw path already checks is_frozen (fn_send_message,
-- fn_confirm_topup, fn_initiate_withdrawal, fn_release_escrow,
-- fn_transfer_credit) — this is only ever the first thing to actually SET
-- it outside Studio or an automated (non-admin) fraud/chargeback path.
-- =============================================================================

create function public.fn_admin_set_wallet_frozen(
  p_actor_admin_id uuid,
  p_wallet_id uuid,
  p_frozen boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before boolean;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'resolve_fraud_signal') then
    raise exception 'not_authorized';
  end if;

  select is_frozen into v_before from public.wallets where id = p_wallet_id for update;
  if not found then
    raise exception 'wallet_not_found';
  end if;

  update public.wallets set is_frozen = p_frozen where id = p_wallet_id;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, before_state, after_state)
  values (
    p_actor_admin_id,
    case when p_frozen then 'freeze_wallet' else 'unfreeze_wallet' end,
    'wallets',
    p_wallet_id::text,
    jsonb_build_object('is_frozen', v_before),
    jsonb_build_object('is_frozen', p_frozen, 'reason', p_reason)
  );
end;
$$;

revoke execute on function public.fn_admin_set_wallet_frozen(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_admin_set_wallet_frozen(uuid, uuid, boolean, text) to service_role;

-- =============================================================================
-- fn_admin_set_user_suspended — same shape, for users.is_suspended. The
-- underlying primitive fn_admin_resolve_user_report composes from below,
-- so "suspend" and "ban" are reversible the same way "freeze" is, rather
-- than being modeled as a one-way action.
-- =============================================================================

create function public.fn_admin_set_user_suspended(
  p_actor_admin_id uuid,
  p_user_id uuid,
  p_suspended boolean,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before boolean;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'resolve_user_report') then
    raise exception 'not_authorized';
  end if;

  select is_suspended into v_before from public.users where id = p_user_id for update;
  if not found then
    raise exception 'user_not_found';
  end if;

  update public.users set is_suspended = p_suspended where id = p_user_id;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, before_state, after_state)
  values (
    p_actor_admin_id,
    case when p_suspended then 'suspend_user' else 'unsuspend_user' end,
    'users',
    p_user_id::text,
    jsonb_build_object('is_suspended', v_before),
    jsonb_build_object('is_suspended', p_suspended, 'reason', p_reason)
  );
end;
$$;

revoke execute on function public.fn_admin_set_user_suspended(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_admin_set_user_suspended(uuid, uuid, boolean, text) to service_role;

-- =============================================================================
-- fn_admin_resolve_fraud_signal — dismiss or escalate. No auto-action ever
-- fires from this (docs/14 §6, docs/06-SECURITY-FRAUD-LOOPHOLES.md §12's
-- standing product decision) — freezing a wallet is always its own,
-- separate, explicit fn_admin_set_wallet_frozen call, never bundled into
-- resolving the signal itself. Escalating bumps severity to 'high' if it
-- wasn't already, since that's the whole point of the word; dismissing
-- touches nothing but the resolution columns.
-- =============================================================================

create function public.fn_admin_resolve_fraud_signal(
  p_actor_admin_id uuid,
  p_signal_id uuid,
  p_resolution text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'resolve_fraud_signal') then
    raise exception 'not_authorized';
  end if;

  if p_resolution not in ('dismissed', 'escalated') then
    raise exception 'invalid_resolution';
  end if;

  update public.fraud_signals
  set resolved_at = now(),
      resolved_by = p_actor_admin_id,
      resolution = p_resolution,
      resolution_note = p_note,
      severity = case when p_resolution = 'escalated' then 'high' else severity end
  where id = p_signal_id and resolved_at is null;

  if not found then
    raise exception 'signal_not_found_or_already_resolved';
  end if;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, after_state)
  values (p_actor_admin_id, 'resolve_fraud_signal', 'fraud_signals', p_signal_id::text, jsonb_build_object('resolution', p_resolution, 'note', p_note));
end;
$$;

revoke execute on function public.fn_admin_resolve_fraud_signal(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_admin_resolve_fraud_signal(uuid, uuid, text, text) to service_role;

-- =============================================================================
-- fn_admin_resolve_user_report — warn/suspend/ban/dismiss. "Banned" is
-- deliberately the same is_suspended flag as "suspended", not a second
-- account-status dimension — nothing else in this schema models a
-- distinct permanent-ban state, and inventing one here would be scope
-- creep beyond what docs/14 actually specifies. The two labels stay
-- distinct in the audit trail (resolution column), which is what actually
-- matters for a human reviewing history later.
-- =============================================================================

create function public.fn_admin_resolve_user_report(
  p_actor_admin_id uuid,
  p_report_id uuid,
  p_resolution text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reported_user_id uuid;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'resolve_user_report') then
    raise exception 'not_authorized';
  end if;

  if p_resolution not in ('warned', 'suspended', 'banned', 'dismissed') then
    raise exception 'invalid_resolution';
  end if;

  select reported_user_id into v_reported_user_id from public.user_reports where id = p_report_id;
  if not found then
    raise exception 'report_not_found';
  end if;

  update public.user_reports
  set resolved_at = now(),
      resolved_by = p_actor_admin_id,
      resolution = p_resolution,
      resolution_note = p_note
  where id = p_report_id and resolved_at is null;

  if not found then
    raise exception 'report_not_found_or_already_resolved';
  end if;

  if p_resolution in ('suspended', 'banned') then
    perform public.fn_admin_set_user_suspended(p_actor_admin_id, v_reported_user_id, true, p_note);
  end if;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, after_state)
  values (p_actor_admin_id, 'resolve_user_report', 'user_reports', p_report_id::text, jsonb_build_object('resolution', p_resolution, 'note', p_note, 'reported_user_id', v_reported_user_id));
end;
$$;

revoke execute on function public.fn_admin_resolve_user_report(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_admin_resolve_user_report(uuid, uuid, text, text) to service_role;
