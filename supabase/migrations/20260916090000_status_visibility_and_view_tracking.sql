-- Status visibility + view tracking (Phase 6, docs/08-BUILD-PHASES-ROADMAP.md
-- line 53-56). `20260912072749_rls_policies.sql`'s status_updates_select_own
-- explicitly deferred "visibility to contacts/thread partners" to this phase
-- rather than guessing at it. This app has no phone-contacts-sync concept
-- (unlike WhatsApp) — a `threads` row is the closest equivalent to a
-- "contact", so a status is visible to anyone the poster has a non-blocked
-- thread with, mirroring the "contacts see your status" convention.
--
-- =============================================================================
-- status_updates — second permissive SELECT policy. Postgres ORs multiple
-- permissive policies together for the same command, so this ADDS visibility
-- on top of status_updates_select_own rather than replacing it (own status is
-- always visible regardless of thread state, including after it's expired,
-- via that original policy — only OTHER people's statuses are gated by this
-- one, and only while unexpired).
-- =============================================================================

create policy status_updates_select_visible_to_thread_partner on public.status_updates
  for select
  to authenticated
  using (
    expires_at > now()
    and exists (
      select 1 from public.threads t
      where t.blocked_by is null
        and (
          (t.participant_a = auth.uid() and t.participant_b = status_updates.user_id)
          or (t.participant_b = auth.uid() and t.participant_a = status_updates.user_id)
        )
    )
  );

-- =============================================================================
-- status_views — records that a viewer has seen a poster's status, driving
-- the unseen(gold)/seen(grey) ring distinction docs/04-DESIGN-SYSTEM.md line
-- 87 specifies. No INSERT policy: all writes go through fn_mark_status_viewed
-- below, not a raw client insert — a raw insert could record a view on a
-- status the viewer isn't actually allowed to see, or backdate viewed_at.
-- Same "every write through a validating function" posture
-- fn_mark_thread_read (20260914080000_thread_read_cursor.sql) already
-- established for read-state, not a money rule, applied here for the same
-- reason.
-- =============================================================================

create table public.status_views (
  status_id uuid not null references public.status_updates (id) on delete cascade,
  viewer_id uuid not null references public.users (id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (status_id, viewer_id)
);

create index status_views_viewer_id_idx on public.status_views (viewer_id);

alter table public.status_views enable row level security;

create policy status_views_select_own on public.status_views
  for select
  to authenticated
  using (viewer_id = auth.uid());

-- =============================================================================
-- fn_mark_status_viewed — records p_viewer_id has seen p_status_id, after
-- re-checking the same visibility condition as the RLS policy above (a
-- SECURITY DEFINER function bypasses RLS, so the check has to be repeated
-- explicitly here rather than relied on implicitly). A poster viewing their
-- own status is a no-op, not an error — there's nothing to "mark seen" about
-- your own post, and the mobile client's viewer modal has no reason to treat
-- that as a failure case.
-- =============================================================================

create function public.fn_mark_status_viewed(p_status_id uuid, p_viewer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status status_updates%rowtype;
  v_visible boolean;
begin
  select * into v_status from status_updates where id = p_status_id;
  if not found then
    raise exception 'status_not_found';
  end if;

  if v_status.user_id = p_viewer_id then
    return;
  end if;

  select exists (
    select 1 from threads t
    where t.blocked_by is null
      and (
        (t.participant_a = p_viewer_id and t.participant_b = v_status.user_id)
        or (t.participant_b = p_viewer_id and t.participant_a = v_status.user_id)
      )
  ) into v_visible;

  if not v_visible then
    raise exception 'not_visible';
  end if;

  insert into status_views (status_id, viewer_id)
  values (p_status_id, p_viewer_id)
  on conflict (status_id, viewer_id) do nothing;
end;
$$;

-- CLAUDE.md rule #11: explicit revoke from public, anon, AND authenticated in
-- the same migration as the create — revoking from public alone is a no-op
-- on this Supabase project (see 20260915161500_lock_security_definer_execute_grants.sql).
revoke execute on function public.fn_mark_status_viewed(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_mark_status_viewed(uuid, uuid) to service_role;
