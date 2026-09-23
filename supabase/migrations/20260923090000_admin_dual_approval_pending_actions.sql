-- Admin dashboard Phase E piece 1 (docs/14-ADMIN-DASHBOARD-SCOPING.md §4.4/§9)
-- — dual-approval schema + the core propose/approve/reject/consume engine.
-- Nothing in this migration wires a real action (pricing changes, manual
-- ledger adjustments) through it yet — that's piece 2. This piece is the
-- generic, reusable machinery every future dual-approved action_type plugs
-- into.
--
-- Real findings from the pre-build review (docs/00-SESSION-HANDOFF.md
-- session 28 end, confirmed directly against the live schema/functions,
-- not assumed) that shape the design below:
--
--   1. `finance_admin` holds both `post_manual_adjustment` and
--      `approve_pending_action` (seeded together in
--      20260920110000_admin_rbac_schema.sql), and `super_admin` holds
--      every permission that exists. Permission possession alone does not
--      guarantee two DIFFERENT people acted — §4.4's "a different admin...
--      approves it" has to be a hard `requested_by <> actor` check inside
--      fn_admin_approve_pending_action, not an assumption the role table
--      happens to enforce it.
--   2. fn_admin_update_pricing_config (Phase D) currently applies every
--      change immediately with zero gate — confirmed by reading it
--      directly. Piece 2 adds the gate; this piece only builds the gate
--      itself.
--   3. No manual-ledger-adjustment posting function exists anywhere yet,
--      despite `manual_adjustment` already being a live ledger_entries
--      reason. That function is a first-ever build in piece 2, so it goes
--      in dual-approval-gated from birth — never shipped open the way
--      pricing was.
--
-- Schema deviation from §4.4's literal column list, decided while
-- building: the doc lists only `approved_by`/`approved_at` (nullable).
-- Overloading those two columns to also mean "rejected by/at" would make
-- a rejected row indistinguishable from an approved one without also
-- checking `status`, which is fragile — this adds a parallel
-- `rejected_by`/`rejected_at`/`rejection_reason` triple instead, and an
-- `executed_at` marker so an approved action can be consumed exactly once
-- by the SECURITY DEFINER function that actually performs it (piece 2),
-- with the "claim it once" guarantee coming from a single atomic
-- UPDATE...WHERE...RETURNING, not a separate locking step.
--
-- Expiry (status = 'expired') is enforced lazily: fn_admin_approve_pending_
-- action and fn_admin_reject_pending_action both check
-- `requested_at < now() - interval '72 hours'` before honoring any
-- decision on a still-'pending' row and raise rather than silently
-- proceeding — that raise is the real enforcement, a stale row can never
-- be approved or rejected no matter what. It deliberately does NOT also
-- try to persist the status flip to 'expired' in the same call: an
-- uncaught RAISE EXCEPTION unwinds every change the current function call
-- made, including an UPDATE issued right before it (caught by this
-- migration's own test — an earlier draft tried exactly that "update
-- then raise" and the update silently never stuck). Persisting the
-- visible 'expired' status is the sweep's job alone. The hourly cron
-- below calls it (cosmetic — the queue's displayed status stays honest
-- without requiring someone to click approve on a stale row first) and
-- uses this project's existing direct-SQL cron.schedule pattern
-- (20260912081331_wire_scheduled_jobs.sql), not a new edge function.

create table public.admin_pending_actions (
  id uuid primary key default gen_random_uuid(),
  -- Widen this check (and fn_admin_pending_action_required_permission
  -- below) together when a future phase adds a new dual-approved action —
  -- same "widen deliberately" precedent as ledger_entries.reason.
  action_type text not null check (action_type in ('pricing_config_update', 'manual_ledger_adjustment')),
  payload jsonb not null,
  requested_by uuid not null references public.admin_users(id),
  requested_at timestamptz not null default now(),
  approved_by uuid references public.admin_users(id),
  approved_at timestamptz,
  rejected_by uuid references public.admin_users(id),
  rejected_at timestamptz,
  rejection_reason text,
  executed_at timestamptz,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired'))
);

create index admin_pending_actions_status_idx on public.admin_pending_actions (status, requested_at desc);
create index admin_pending_actions_requested_by_idx on public.admin_pending_actions (requested_by);

alter table public.admin_pending_actions enable row level security;

-- Same posture as admin_audit_log: this project's default ACL grants
-- anon/authenticated/service_role full DML on a freshly created table
-- (confirmed live — admin_audit_log needed the identical explicit
-- revoke), so every write path here must go through the SECURITY DEFINER
-- functions below. The admin dashboard's queue UI reads this table
-- directly (same pattern as fraud_signals/pricing_config), so
-- service_role keeps SELECT.
revoke insert, update, delete on public.admin_pending_actions from public, anon, authenticated, service_role;
grant select on public.admin_pending_actions to service_role;

-- =============================================================================
-- fn_admin_pending_action_required_permission — single source of truth for
-- "which permission does this action_type need," shared by propose/
-- approve/reject so the mapping can't drift between them. Pure mapping, no
-- table access — locked down anyway for the same no-exceptions posture as
-- everything else in this file, not because it's independently risky.
-- =============================================================================

create function public.fn_admin_pending_action_required_permission(p_action_type text)
returns text
language sql
immutable
as $$
  select case p_action_type
    when 'pricing_config_update' then 'edit_pricing_config'
    when 'manual_ledger_adjustment' then 'post_manual_adjustment'
    else null
  end;
$$;

revoke execute on function public.fn_admin_pending_action_required_permission(text) from public, anon, authenticated;
grant execute on function public.fn_admin_pending_action_required_permission(text) to service_role;

-- =============================================================================
-- fn_admin_propose_pending_action — the only way an admin_pending_actions
-- row gets created. Requires the same permission the underlying action
-- would need to run directly (e.g. edit_pricing_config to propose a
-- pricing change) — proposing isn't a lesser-privileged action than doing
-- it, it's the first half of doing it.
-- =============================================================================

create function public.fn_admin_propose_pending_action(
  p_actor_admin_id uuid,
  p_action_type text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_required_permission text;
  v_id uuid;
begin
  v_required_permission := public.fn_admin_pending_action_required_permission(p_action_type);
  if v_required_permission is null then
    raise exception 'unknown_action_type: %', p_action_type;
  end if;

  if not public.fn_admin_check_permission(p_actor_admin_id, v_required_permission) then
    raise exception 'not_authorized';
  end if;

  insert into public.admin_pending_actions (action_type, payload, requested_by)
  values (p_action_type, p_payload, p_actor_admin_id)
  returning id into v_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'propose_pending_action',
    'admin_pending_actions',
    v_id::text,
    null,
    jsonb_build_object('action_type', p_action_type, 'payload', p_payload),
    null
  );

  return v_id;
end;
$$;

revoke execute on function public.fn_admin_propose_pending_action(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_admin_propose_pending_action(uuid, text, jsonb) to service_role;

-- =============================================================================
-- fn_admin_approve_pending_action — closes the real self-approval gap
-- found in the pre-build review: `requested_by = actor` is rejected
-- outright, regardless of what permissions the actor holds. An approver
-- also needs BOTH the action's own underlying permission (e.g.
-- edit_pricing_config) AND the generic approve_pending_action permission
-- — "matching permission" per §4.4, not just a generic rubber-stamp
-- capability with no relation to what's being approved.
-- =============================================================================

create function public.fn_admin_approve_pending_action(
  p_actor_admin_id uuid,
  p_pending_action_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.admin_pending_actions%rowtype;
  v_required_permission text;
begin
  select * into v_row from public.admin_pending_actions where id = p_pending_action_id for update;
  if not found then
    raise exception 'pending_action_not_found';
  end if;

  if v_row.status = 'pending' and v_row.requested_at < now() - interval '72 hours' then
    raise exception 'pending_action_expired';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'pending_action_not_pending: current status is %', v_row.status;
  end if;

  if v_row.requested_by = p_actor_admin_id then
    raise exception 'cannot_approve_own_action';
  end if;

  v_required_permission := public.fn_admin_pending_action_required_permission(v_row.action_type);
  if not public.fn_admin_check_permission(p_actor_admin_id, v_required_permission)
     or not public.fn_admin_check_permission(p_actor_admin_id, 'approve_pending_action')
  then
    raise exception 'not_authorized';
  end if;

  update public.admin_pending_actions
  set status = 'approved', approved_by = p_actor_admin_id, approved_at = now()
  where id = p_pending_action_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'approve_pending_action',
    'admin_pending_actions',
    p_pending_action_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'approved'),
    null
  );
end;
$$;

revoke execute on function public.fn_admin_approve_pending_action(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_admin_approve_pending_action(uuid, uuid) to service_role;

-- =============================================================================
-- fn_admin_reject_pending_action — unlike approval, the original requester
-- may reject (cancel) their own proposal without holding
-- approve_pending_action; anyone else needs the same matching-permission
-- pair approval requires.
-- =============================================================================

create function public.fn_admin_reject_pending_action(
  p_actor_admin_id uuid,
  p_pending_action_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.admin_pending_actions%rowtype;
  v_required_permission text;
  v_is_requester boolean;
begin
  select * into v_row from public.admin_pending_actions where id = p_pending_action_id for update;
  if not found then
    raise exception 'pending_action_not_found';
  end if;

  if v_row.status = 'pending' and v_row.requested_at < now() - interval '72 hours' then
    raise exception 'pending_action_expired';
  end if;

  if v_row.status <> 'pending' then
    raise exception 'pending_action_not_pending: current status is %', v_row.status;
  end if;

  v_is_requester := v_row.requested_by = p_actor_admin_id;
  v_required_permission := public.fn_admin_pending_action_required_permission(v_row.action_type);

  if not v_is_requester
     and not (
       public.fn_admin_check_permission(p_actor_admin_id, v_required_permission)
       and public.fn_admin_check_permission(p_actor_admin_id, 'approve_pending_action')
     )
  then
    raise exception 'not_authorized';
  end if;

  update public.admin_pending_actions
  set status = 'rejected', rejected_by = p_actor_admin_id, rejected_at = now(), rejection_reason = p_reason
  where id = p_pending_action_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'reject_pending_action',
    'admin_pending_actions',
    p_pending_action_id::text,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'rejected', 'reason', p_reason),
    null
  );
end;
$$;

revoke execute on function public.fn_admin_reject_pending_action(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_admin_reject_pending_action(uuid, uuid, text) to service_role;

-- =============================================================================
-- fn_admin_consume_approved_pending_action — the bridge piece 2's actual
-- money/config functions call to redeem an approval exactly once. A
-- single atomic UPDATE ... WHERE executed_at is null ... RETURNING is the
-- whole safety guarantee: under real concurrent calls, only one UPDATE
-- can find the row still unexecuted, the same "claim it once" shape this
-- codebase already trusts elsewhere (e.g. reconcile-topups' MIN_AGE_MINUTES
-- guard) — no separate SELECT ... FOR UPDATE step needed since there's
-- only one branch to decide, not several.
-- =============================================================================

create function public.fn_admin_consume_approved_pending_action(
  p_pending_action_id uuid,
  p_expected_action_type text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  update public.admin_pending_actions
  set executed_at = now()
  where id = p_pending_action_id
    and action_type = p_expected_action_type
    and status = 'approved'
    and executed_at is null
  returning payload into v_payload;

  if not found then
    raise exception 'pending_action_not_approved_or_already_executed';
  end if;

  return v_payload;
end;
$$;

revoke execute on function public.fn_admin_consume_approved_pending_action(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_admin_consume_approved_pending_action(uuid, text) to service_role;

-- =============================================================================
-- Cosmetic hourly sweep — see header comment. Real enforcement lives in
-- the lazy checks above.
-- =============================================================================

create function public.fn_admin_expire_stale_pending_actions()
returns int
language sql
security definer
set search_path = public
as $$
  with expired as (
    update public.admin_pending_actions
    set status = 'expired'
    where status = 'pending' and requested_at < now() - interval '72 hours'
    returning 1
  )
  select count(*)::int from expired;
$$;

revoke execute on function public.fn_admin_expire_stale_pending_actions() from public, anon, authenticated;
grant execute on function public.fn_admin_expire_stale_pending_actions() to service_role;

select cron.schedule(
  'expire-stale-pending-actions',
  '0 * * * *', -- hourly; cosmetic only, see header comment
  $$ select public.fn_admin_expire_stale_pending_actions(); $$
);
