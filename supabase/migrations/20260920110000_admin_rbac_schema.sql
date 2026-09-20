-- Admin dashboard Phase A (docs/14-ADMIN-DASHBOARD-SCOPING.md §4.1, §8.1) —
-- RBAC schema. Additive only, nothing existing changes shape.
--
-- Deliberately NOT `auth.users`: an admin identity is a completely separate
-- namespace from a consumer phone-OTP account (docs/14 §4.1) — an admin is
-- never also a chat user under the same row, and this table gets its own
-- custom auth (argon2id password + TOTP), not Supabase Auth, per the
-- explicit decision recorded in docs/14 §8.1 point 2.
--
-- Same posture as every other internal-only table this codebase already has
-- (fraud_signals, pricing_config_history, per
-- 20260912072749_rls_policies.sql's own comment): RLS enabled with zero
-- policies. service_role bypasses RLS entirely regardless of policy count,
-- so this blocks anon/authenticated completely while imposing nothing on
-- the Next.js backend, which only ever connects with the service role key.
-- No table here gets a client-facing SELECT/INSERT/UPDATE/DELETE policy,
-- now or in a later phase — every read and write goes through this
-- migration's sibling (SECURITY DEFINER functions), same rule #11
-- discipline the rest of this codebase already follows.

-- =============================================================================
-- admin_users
-- =============================================================================

create table public.admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  password_hash text not null,
  totp_secret_encrypted text,
  totp_enrolled_at timestamptz,
  recovery_code_hashes text[] not null default '{}',
  failed_login_count int not null default 0,
  locked_until timestamptz,
  disabled_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);

comment on column public.admin_users.totp_secret_encrypted is
  'AES-256-GCM ciphertext, encrypted/decrypted in the Next.js server layer using ADMIN_TOTP_ENCRYPTION_KEY — this table never sees a plaintext TOTP secret, per docs/14 §8.1 point 2''s decision to keep all crypto in the app layer, not split across Postgres and Node.';

comment on column public.admin_users.recovery_code_hashes is
  'argon2id hashes of one-time MFA recovery codes (docs/14 §8.1 point 3). Each is removed from the array the moment it is consumed — a recovery code is single-use by construction, not by a separate "used" flag.';

-- =============================================================================
-- admin_roles / admin_permissions / admin_role_permissions / admin_user_roles
-- =============================================================================

create table public.admin_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null,
  created_at timestamptz not null default now()
);

create table public.admin_permissions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text not null
);

create table public.admin_role_permissions (
  role_id uuid not null references public.admin_roles(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  primary key (role_id, permission_id)
);

create table public.admin_user_roles (
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  role_id uuid not null references public.admin_roles(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (admin_user_id, role_id)
);

-- =============================================================================
-- admin_audit_log — append-only, same posture as ledger_entries. No
-- UPDATE/DELETE grant to any role, ever (enforced below, not just asserted).
-- =============================================================================

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references public.admin_users(id),
  action text not null,
  target_type text,
  target_id text,
  before_state jsonb,
  after_state jsonb,
  ip_address text,
  created_at timestamptz not null default now()
);

create index admin_audit_log_admin_user_id_idx on public.admin_audit_log (admin_user_id, created_at desc);
create index admin_audit_log_target_idx on public.admin_audit_log (target_type, target_id);

-- Append-only, enforced by trigger rather than by grant alone — same
-- pattern and same reasoning as ledger_entries' own
-- prevent_ledger_mutation() (this migration's sibling file adds a REVOKE
-- too, but a trigger is the proven belt-and-suspenders mechanism in this
-- codebase for "even service_role can't mutate this," since service_role
-- bypasses RLS and this project has already been burned once by an
-- assumption about what a REVOKE actually blocks, per
-- 20260915161500_lock_security_definer_execute_grants.sql).
create function public.prevent_admin_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'admin_audit_log is append-only — % is not permitted (row id: %)',
    tg_op, coalesce(old.id, new.id);
end;
$$;

create trigger admin_audit_log_no_update
  before update on public.admin_audit_log
  for each row execute function public.prevent_admin_audit_log_mutation();

create trigger admin_audit_log_no_delete
  before delete on public.admin_audit_log
  for each row execute function public.prevent_admin_audit_log_mutation();

-- =============================================================================
-- RLS: enabled, zero policies, on every table above
-- =============================================================================

alter table public.admin_users enable row level security;
alter table public.admin_roles enable row level security;
alter table public.admin_permissions enable row level security;
alter table public.admin_role_permissions enable row level security;
alter table public.admin_user_roles enable row level security;
alter table public.admin_audit_log enable row level security;

-- =============================================================================
-- Seed: the 6 roles from docs/14 §4.1's table, and one atomic permission per
-- capability named in that table plus §9's phase list. Additional
-- permissions get added as later phases need them (e.g. initiate_platform_
-- withdrawal isn't checkable by anything until Phase F exists) — seeding
-- them now, ungranted to any role yet, costs nothing and means a future
-- migration only has to INSERT the role_permissions row, not the permission
-- itself.
-- =============================================================================

insert into public.admin_permissions (name, description) values
  ('view_users', 'View user profiles, wallets, transaction history'),
  ('view_treasury', 'View platform wallet balances and revenue/reserve history'),
  ('view_reports_queue', 'View fraud_signals and user_reports queues'),
  ('resolve_fraud_signal', 'Dismiss/escalate a fraud signal, freeze/unfreeze a wallet'),
  ('moderate_content', 'Action items in the content moderation queue'),
  ('edit_pricing_config', 'Change pricing_config values, service on/off toggles, active pricing strategy'),
  ('post_manual_adjustment', 'Post a manual ledger adjustment (dual-approved above the materiality threshold)'),
  ('approve_pending_action', 'Approve another admin''s proposed dual-approval action'),
  ('initiate_platform_withdrawal', 'Propose a platform treasury withdrawal (still requires a second admin''s approval, no materiality floor)'),
  ('manage_admin_roles', 'Create/disable admin accounts, assign roles, reset another admin''s MFA'),
  ('view_audit_log', 'Read admin_audit_log directly')
on conflict (name) do nothing;

insert into public.admin_roles (name, description) values
  ('super_admin', 'Everything, plus manage other admins'' roles, edit the permission model itself, initiate platform treasury withdrawals'),
  ('finance_admin', 'View/adjust pricing_config, view treasury + all wallets, post manual ledger adjustments (dual-approved); cannot manage admin roles'),
  ('compliance_officer', 'View KYC records, fraud_signals, user_reports; freeze/unfreeze wallets; cannot touch pricing or treasury'),
  ('support_agent', 'View user profiles, thread metadata (never message content by default); resolve user_reports at the "contacted user" level; cannot freeze wallets or touch money'),
  ('content_moderator', 'View moderated_content flagged queue, action content-policy violations; no financial access at all'),
  ('read_only_auditor', 'View everything (analytics, treasury, audit log itself), write nothing')
on conflict (name) do nothing;

-- super_admin: every permission that exists today.
insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from public.admin_roles r
cross join public.admin_permissions p
where r.name = 'super_admin'
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from public.admin_roles r, public.admin_permissions p
where r.name = 'finance_admin'
  and p.name in ('view_users', 'view_treasury', 'edit_pricing_config', 'post_manual_adjustment', 'approve_pending_action')
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from public.admin_roles r, public.admin_permissions p
where r.name = 'compliance_officer'
  and p.name in ('view_users', 'view_reports_queue', 'resolve_fraud_signal')
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from public.admin_roles r, public.admin_permissions p
where r.name = 'support_agent'
  and p.name in ('view_users', 'view_reports_queue')
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from public.admin_roles r, public.admin_permissions p
where r.name = 'content_moderator'
  and p.name in ('moderate_content')
on conflict do nothing;

insert into public.admin_role_permissions (role_id, permission_id)
select r.id, p.id
from public.admin_roles r, public.admin_permissions p
where r.name = 'read_only_auditor'
  and p.name in ('view_users', 'view_treasury', 'view_reports_queue', 'view_audit_log')
on conflict do nothing;
