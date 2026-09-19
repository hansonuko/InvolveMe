-- Full group admin/profile system (punch-list item 2, 2026-09-19): the
-- gaps 20260918100000_free_group_messaging.sql's own header comment
-- explicitly deferred as v2 — "leaving a group, removing a member,
-- renaming a group, adding members after creation, a group avatar" — plus
-- promote/demote admin, which that list didn't call out but the same
-- header's "created_by is the fixed group owner ... no ownership-transfer
-- path" note already implies needs its own guard once removal/role-change
-- exists (the owner must never become removable or demotable, since
-- fn_send_group_message's whole 70/30 split is keyed to created_by being
-- fixed).
--
-- Permission model, chosen to match WhatsApp's actual default (not every
-- action is admin-only): any current member can add new members (WhatsApp's
-- "Add participants" is open to all members by default, only restrictable
-- to admins via a per-group setting this app doesn't build yet); removing a
-- member, promoting/demoting admin, and editing the group's name/
-- description/avatar are admin-only, same as WhatsApp always requires for
-- those regardless of that setting. The owner (created_by) can never be
-- removed or demoted — no exception, since there's no ownership-transfer
-- path yet to hand the earner role to someone else first.
--
-- Every function here locks the group_threads row (`for update`) before
-- checking membership/role, same reasoning fn_send_group_message already
-- documents for wallet rows: it serializes concurrent admin actions on the
-- same group (e.g. two admins removing the same member at once) rather
-- than leaving that race to whichever write lands last.

alter table public.group_threads
  add column description text;

alter table public.group_threads
  add constraint group_threads_description_length check (
    description is null or length(description) <= 500
  );

-- =============================================================================
-- fn_add_group_members — any current member can add more, up to the same
-- 100-member cap fn_create_group_thread enforces at creation.
-- =============================================================================

create function public.fn_add_group_members(
  p_group_thread_id uuid,
  p_actor_id uuid,
  p_member_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_count integer;
  v_new_ids uuid[];
  v_added_count integer;
  v_max_members constant integer := 100;
begin
  if not exists (select 1 from group_threads where id = p_group_thread_id for update) then
    raise exception 'group_not_found';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_actor_id
  ) then
    raise exception 'not_a_member';
  end if;

  -- Dedupe, drop nulls, drop anyone already a member.
  select array_agg(distinct m) into v_new_ids
  from unnest(p_member_ids) as m
  where m is not null
    and not exists (
      select 1 from group_members
      where group_thread_id = p_group_thread_id and user_id = m
    );

  if v_new_ids is null or array_length(v_new_ids, 1) = 0 then
    raise exception 'no_new_members';
  end if;

  if exists (
    select 1 from unnest(v_new_ids) as m
    where not exists (select 1 from users where id = m)
  ) then
    raise exception 'member_not_found';
  end if;

  select count(*) into v_current_count from group_members
  where group_thread_id = p_group_thread_id;

  if v_current_count + array_length(v_new_ids, 1) > v_max_members then
    raise exception 'too_many_members: max % total', v_max_members;
  end if;

  insert into group_members (group_thread_id, user_id, role)
  select p_group_thread_id, m, 'member' from unnest(v_new_ids) as m;

  get diagnostics v_added_count = row_count;
  return v_added_count;
end;
$$;

revoke execute on function public.fn_add_group_members(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.fn_add_group_members(uuid, uuid, uuid[]) to service_role;

-- =============================================================================
-- fn_remove_group_member — admin-only; the owner can never be removed.
-- =============================================================================

create function public.fn_remove_group_member(
  p_group_thread_id uuid,
  p_actor_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.group_threads%rowtype;
  v_actor_role text;
begin
  select * into v_group from group_threads where id = p_group_thread_id for update;
  if not found then
    raise exception 'group_not_found';
  end if;

  select role into v_actor_role from group_members
  where group_thread_id = p_group_thread_id and user_id = p_actor_id;
  if v_actor_role is null then
    raise exception 'not_a_member';
  end if;
  if v_actor_role <> 'admin' then
    raise exception 'not_admin';
  end if;

  if p_target_user_id = v_group.created_by then
    raise exception 'cannot_remove_owner';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_target_user_id
  ) then
    raise exception 'target_not_a_member';
  end if;

  delete from group_members
  where group_thread_id = p_group_thread_id and user_id = p_target_user_id;
end;
$$;

revoke execute on function public.fn_remove_group_member(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_remove_group_member(uuid, uuid, uuid) to service_role;

-- =============================================================================
-- fn_leave_group — self-service remove; the owner is blocked, same
-- underlying reason fn_remove_group_member blocks removing them.
-- =============================================================================

create function public.fn_leave_group(
  p_group_thread_id uuid,
  p_actor_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.group_threads%rowtype;
begin
  select * into v_group from group_threads where id = p_group_thread_id for update;
  if not found then
    raise exception 'group_not_found';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_actor_id
  ) then
    raise exception 'not_a_member';
  end if;

  if p_actor_id = v_group.created_by then
    raise exception 'owner_cannot_leave';
  end if;

  delete from group_members
  where group_thread_id = p_group_thread_id and user_id = p_actor_id;
end;
$$;

revoke execute on function public.fn_leave_group(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_leave_group(uuid, uuid) to service_role;

-- =============================================================================
-- fn_set_group_member_role — promote/demote; admin-only, the owner's own
-- role can never be changed (always 'admin').
-- =============================================================================

create function public.fn_set_group_member_role(
  p_group_thread_id uuid,
  p_actor_id uuid,
  p_target_user_id uuid,
  p_role text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.group_threads%rowtype;
  v_actor_role text;
begin
  if p_role not in ('admin', 'member') then
    raise exception 'invalid_role';
  end if;

  select * into v_group from group_threads where id = p_group_thread_id for update;
  if not found then
    raise exception 'group_not_found';
  end if;

  select role into v_actor_role from group_members
  where group_thread_id = p_group_thread_id and user_id = p_actor_id;
  if v_actor_role is null then
    raise exception 'not_a_member';
  end if;
  if v_actor_role <> 'admin' then
    raise exception 'not_admin';
  end if;

  if p_target_user_id = v_group.created_by then
    raise exception 'cannot_change_owner_role';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_target_user_id
  ) then
    raise exception 'target_not_a_member';
  end if;

  update group_members set role = p_role
  where group_thread_id = p_group_thread_id and user_id = p_target_user_id;
end;
$$;

revoke execute on function public.fn_set_group_member_role(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_set_group_member_role(uuid, uuid, uuid, text) to service_role;

-- =============================================================================
-- fn_update_group_profile — admin-only; name/description/avatar_url are
-- each independently optional (null = leave unchanged). An empty string on
-- description clears it (distinct from null); name can't be blanked, same
-- non-empty/60-char rule fn_create_group_thread already enforces.
-- =============================================================================

create function public.fn_update_group_profile(
  p_group_thread_id uuid,
  p_actor_id uuid,
  p_name text default null,
  p_description text default null,
  p_avatar_url text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_name text;
begin
  if not exists (select 1 from group_threads where id = p_group_thread_id for update) then
    raise exception 'group_not_found';
  end if;

  select role into v_actor_role from group_members
  where group_thread_id = p_group_thread_id and user_id = p_actor_id;
  if v_actor_role is null then
    raise exception 'not_a_member';
  end if;
  if v_actor_role <> 'admin' then
    raise exception 'not_admin';
  end if;

  if p_name is not null then
    v_name := trim(both from p_name);
    if length(v_name) = 0 then
      raise exception 'group_name_required';
    end if;
    if length(v_name) > 60 then
      raise exception 'group_name_too_long';
    end if;
  end if;

  if p_description is not null and length(p_description) > 500 then
    raise exception 'group_description_too_long';
  end if;

  update group_threads set
    name = coalesce(v_name, name),
    description = coalesce(p_description, description),
    avatar_url = coalesce(p_avatar_url, avatar_url)
  where id = p_group_thread_id;
end;
$$;

revoke execute on function public.fn_update_group_profile(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_update_group_profile(uuid, uuid, text, text, text) to service_role;
