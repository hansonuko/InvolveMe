-- Admin dashboard Phase A (docs/14-ADMIN-DASHBOARD-SCOPING.md §4.1, §4.4,
-- §8.1) — SECURITY DEFINER functions over the RBAC schema from
-- 20260920110000_admin_rbac_schema.sql.
--
-- CLAUDE.md rule #11: every SECURITY DEFINER function gets an explicit
-- `revoke execute ... from public, anon, authenticated` + `grant execute
-- ... to service_role` immediately after its `create function`, in this
-- same migration, no exceptions — this codebase's own default-ACL setup
-- grants anon/authenticated execute directly at CREATE FUNCTION time, so
-- `revoke ... from public` alone is a no-op here (confirmed by direct
-- testing in 20260915161500_lock_security_definer_execute_grants.sql).
--
-- Password hashing (argon2id) and TOTP secret encryption/verification both
-- happen in the Next.js server layer (docs/14 §8.1 point 2) — these
-- functions store/compare opaque hashes and ciphertext, never plaintext
-- credentials, and never run crypto themselves.

-- =============================================================================
-- fn_admin_bootstrap_first_user — the ONLY way an admin_users row can be
-- created with zero prior admins. Refuses if any row already exists, so a
-- second call (accidental re-run, or an attacker who somehow got
-- service-role access after the fact) can never mint a second "free"
-- super_admin. Called exactly once per environment, by
-- scripts/create-first-admin.ts — never by a route a browser can reach.
-- =============================================================================

create function public.fn_admin_bootstrap_first_user(
  p_email text,
  p_display_name text,
  p_password_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
  v_super_admin_role_id uuid;
begin
  if exists (select 1 from public.admin_users) then
    raise exception 'admin_users_not_empty';
  end if;

  select id into v_super_admin_role_id from public.admin_roles where name = 'super_admin';
  if v_super_admin_role_id is null then
    raise exception 'super_admin_role_missing';
  end if;

  insert into public.admin_users (email, display_name, password_hash)
  values (lower(p_email), p_display_name, p_password_hash)
  returning id into v_admin_id;

  insert into public.admin_user_roles (admin_user_id, role_id)
  values (v_admin_id, v_super_admin_role_id);

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, after_state)
  values (v_admin_id, 'bootstrap_first_admin', 'admin_users', v_admin_id::text, jsonb_build_object('email', lower(p_email)));

  return v_admin_id;
end;
$$;

revoke execute on function public.fn_admin_bootstrap_first_user(text, text, text) from public, anon, authenticated;
grant execute on function public.fn_admin_bootstrap_first_user(text, text, text) to service_role;

-- =============================================================================
-- fn_admin_get_login_material — read-only fetch of exactly what a login
-- attempt needs to verify. Never returns recovery_code_hashes (a separate,
-- narrower function handles recovery-code consumption) to keep this
-- function's return shape minimal.
-- =============================================================================

create function public.fn_admin_get_login_material(p_email text)
returns table (
  admin_user_id uuid,
  password_hash text,
  totp_secret_encrypted text,
  totp_enrolled_at timestamptz,
  disabled_at timestamptz,
  failed_login_count int,
  locked_until timestamptz
)
language sql
security definer
set search_path = public
as $$
  select id, password_hash, totp_secret_encrypted, totp_enrolled_at, disabled_at, failed_login_count, locked_until
  from public.admin_users
  where email = lower(p_email);
$$;

revoke execute on function public.fn_admin_get_login_material(text) from public, anon, authenticated;
grant execute on function public.fn_admin_get_login_material(text) to service_role;

-- =============================================================================
-- fn_admin_record_login_attempt — row-locked so two near-simultaneous
-- failed attempts (e.g. a scripted guesser firing requests in parallel)
-- can't both read the same failed_login_count and under-count the lockout,
-- the same "lock the row before you touch the number" discipline
-- CLAUDE.md requires for wallet balances, applied here to a security
-- counter instead of a balance. Lockout: 10 failed attempts -> 15 minute
-- lock, reset to 0 on any success.
-- =============================================================================

create function public.fn_admin_record_login_attempt(
  p_admin_user_id uuid,
  p_success boolean,
  p_ip text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_count int;
begin
  perform 1 from public.admin_users where id = p_admin_user_id for update;
  if not found then
    raise exception 'admin_user_not_found';
  end if;

  if p_success then
    update public.admin_users
    set failed_login_count = 0,
        locked_until = null,
        last_login_at = now()
    where id = p_admin_user_id;

    insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, ip_address)
    values (p_admin_user_id, 'login_success', 'admin_users', p_admin_user_id::text, p_ip);
  else
    update public.admin_users
    set failed_login_count = failed_login_count + 1,
        locked_until = case when failed_login_count + 1 >= 10 then now() + interval '15 minutes' else locked_until end
    where id = p_admin_user_id
    returning failed_login_count into v_new_count;

    insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, ip_address, after_state)
    values (p_admin_user_id, 'login_failure', 'admin_users', p_admin_user_id::text, p_ip, jsonb_build_object('failed_login_count', v_new_count));
  end if;
end;
$$;

revoke execute on function public.fn_admin_record_login_attempt(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_admin_record_login_attempt(uuid, boolean, text) to service_role;

-- =============================================================================
-- fn_admin_check_permission — the one function every protected Server
-- Action/Route Handler calls before doing anything (docs/14 §7.2).
-- =============================================================================

create function public.fn_admin_check_permission(
  p_admin_user_id uuid,
  p_permission text
)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.admin_user_roles ur
    join public.admin_role_permissions rp on rp.role_id = ur.role_id
    join public.admin_permissions p on p.id = rp.permission_id
    join public.admin_users u on u.id = ur.admin_user_id
    where ur.admin_user_id = p_admin_user_id
      and p.name = p_permission
      and u.disabled_at is null
  );
$$;

revoke execute on function public.fn_admin_check_permission(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_admin_check_permission(uuid, text) to service_role;

-- =============================================================================
-- fn_admin_create_user — the only way a second (or later) admin gets
-- created. Requires the creator to hold manage_admin_roles and not be
-- disabled; every role_id passed must be a real row (bad input fails loud,
-- not silently ignored).
-- =============================================================================

create function public.fn_admin_create_user(
  p_creator_admin_id uuid,
  p_email text,
  p_display_name text,
  p_password_hash text,
  p_role_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_admin_id uuid;
  v_role_count int;
begin
  if not public.fn_admin_check_permission(p_creator_admin_id, 'manage_admin_roles') then
    raise exception 'not_authorized';
  end if;

  select count(*) into v_role_count from public.admin_roles where id = any(p_role_ids);
  if v_role_count <> coalesce(array_length(p_role_ids, 1), 0) then
    raise exception 'invalid_role_id';
  end if;

  insert into public.admin_users (email, display_name, password_hash)
  values (lower(p_email), p_display_name, p_password_hash)
  returning id into v_new_admin_id;

  insert into public.admin_user_roles (admin_user_id, role_id)
  select v_new_admin_id, r_id from unnest(p_role_ids) as r_id;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, after_state)
  values (
    p_creator_admin_id,
    'create_admin_user',
    'admin_users',
    v_new_admin_id::text,
    jsonb_build_object('email', lower(p_email), 'role_ids', p_role_ids)
  );

  return v_new_admin_id;
end;
$$;

revoke execute on function public.fn_admin_create_user(uuid, text, text, text, uuid[]) from public, anon, authenticated;
grant execute on function public.fn_admin_create_user(uuid, text, text, text, uuid[]) to service_role;

-- =============================================================================
-- fn_admin_enroll_mfa — first-time TOTP enrollment. Refuses to overwrite an
-- already-enrolled admin (use fn_admin_reset_mfa for that, which requires a
-- different admin's approval per docs/14 §8.1 point 3).
-- =============================================================================

create function public.fn_admin_enroll_mfa(
  p_admin_user_id uuid,
  p_totp_secret_encrypted text,
  p_recovery_code_hashes text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.admin_users
  set totp_secret_encrypted = p_totp_secret_encrypted,
      totp_enrolled_at = now(),
      recovery_code_hashes = p_recovery_code_hashes
  where id = p_admin_user_id
    and totp_enrolled_at is null;

  if not found then
    raise exception 'already_enrolled_or_not_found';
  end if;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id)
  values (p_admin_user_id, 'mfa_enrolled', 'admin_users', p_admin_user_id::text);
end;
$$;

revoke execute on function public.fn_admin_enroll_mfa(uuid, text, text[]) from public, anon, authenticated;
grant execute on function public.fn_admin_enroll_mfa(uuid, text, text[]) to service_role;

-- =============================================================================
-- fn_admin_reset_mfa — the recovery path from docs/14 §8.1 point 3: a
-- DIFFERENT admin with manage_admin_roles clears a locked-out admin's MFA
-- enrollment so they can re-enroll on next login. Self-reset is explicitly
-- rejected — resetting your own MFA is exactly the step an attacker who's
-- already compromised a session would take next.
-- =============================================================================

create function public.fn_admin_reset_mfa(
  p_actor_admin_id uuid,
  p_target_admin_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_actor_admin_id = p_target_admin_id then
    raise exception 'cannot_reset_own_mfa';
  end if;

  if not public.fn_admin_check_permission(p_actor_admin_id, 'manage_admin_roles') then
    raise exception 'not_authorized';
  end if;

  update public.admin_users
  set totp_secret_encrypted = null,
      totp_enrolled_at = null,
      recovery_code_hashes = '{}'
  where id = p_target_admin_id;

  if not found then
    raise exception 'admin_user_not_found';
  end if;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, before_state)
  values (p_actor_admin_id, 'mfa_reset', 'admin_users', p_target_admin_id::text, jsonb_build_object('target_admin_id', p_target_admin_id));
end;
$$;

revoke execute on function public.fn_admin_reset_mfa(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_admin_reset_mfa(uuid, uuid) to service_role;

-- =============================================================================
-- fn_admin_consume_recovery_code — atomic check-and-remove so the same
-- recovery code can never be used twice, including two near-simultaneous
-- attempts (row-locked, same reasoning as fn_admin_record_login_attempt).
-- =============================================================================

create function public.fn_admin_consume_recovery_code(
  p_admin_user_id uuid,
  p_code_hash text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codes text[];
  v_matched boolean;
begin
  select recovery_code_hashes into v_codes
  from public.admin_users
  where id = p_admin_user_id
  for update;

  if not found then
    raise exception 'admin_user_not_found';
  end if;

  v_matched := p_code_hash = any(v_codes);

  if v_matched then
    update public.admin_users
    set recovery_code_hashes = array_remove(v_codes, p_code_hash)
    where id = p_admin_user_id;

    insert into public.admin_audit_log (admin_user_id, action, target_type, target_id)
    values (p_admin_user_id, 'recovery_code_consumed', 'admin_users', p_admin_user_id::text);
  end if;

  return v_matched;
end;
$$;

revoke execute on function public.fn_admin_consume_recovery_code(uuid, text) from public, anon, authenticated;
grant execute on function public.fn_admin_consume_recovery_code(uuid, text) to service_role;

-- =============================================================================
-- fn_admin_log_action — generic append-only audit writer for anything not
-- covered by a more specific function above. admin_audit_log gets no
-- UPDATE/DELETE grant to any role, ever (not even service_role) — the only
-- sanctioned way to add a row is through this function or one of the
-- specific ones above, and there is no function anywhere in this codebase,
-- now or planned, that updates or deletes from it.
-- =============================================================================

create function public.fn_admin_log_action(
  p_admin_user_id uuid,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_before_state jsonb,
  p_after_state jsonb,
  p_ip text
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, before_state, after_state, ip_address)
  values (p_admin_user_id, p_action, p_target_type, p_target_id, p_before_state, p_after_state, p_ip);
$$;

revoke execute on function public.fn_admin_log_action(uuid, text, text, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_admin_log_action(uuid, text, text, text, jsonb, jsonb, text) to service_role;

revoke insert, update, delete on public.admin_audit_log from public, anon, authenticated, service_role;
grant select on public.admin_audit_log to service_role;
