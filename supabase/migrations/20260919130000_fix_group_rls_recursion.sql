-- Fixes a real, live bug: every group feature's client-side read path has
-- been completely broken since group_threads/group_members/group_messages
-- were first created (20260913200000_group_chats.sql) — confirmed live,
-- 2026-09-19, after the user reported creating 3 groups and seeing none of
-- them, plus a group thread that "loads" but a sent message never appears.
-- Reproduced directly: a normal authenticated client (anon key + real
-- user JWT — exactly what the mobile app uses, not the service-role path
-- every existing group test happens to use) selecting from any of the
-- three group tables gets `infinite recursion detected in policy for
-- relation "group_members"` (Postgres SQLSTATE 42P17), not data.
--
-- Root cause: group_members_select_fellow_member's own USING clause
-- self-joins group_members to decide whether a row of group_members is
-- visible:
--
--   exists (select 1 from group_members m where m.group_thread_id = ...)
--
-- Since RLS applies to *every* access to a table, including a subquery
-- inside that table's own policy, evaluating this policy requires
-- re-evaluating this same policy for the inner subquery's rows, which
-- requires evaluating it again for its own inner subquery, and so on —
-- Postgres detects this as literal infinite recursion and errors instead
-- of looping forever. group_threads_select_member and
-- group_messages_select_member both reference group_members in the exact
-- same shape, so any query against *either* of those tables trips the
-- same recursion the moment it has to evaluate group_members' own broken
-- policy underneath.
--
-- Why this went undetected across every prior group-feature session and
-- PR: every automated test for groups (create-group-thread-function.test.js,
-- send-group-message-function.test.js, group-chat-functions.test.js, and
-- this session's own group-admin-actions-function.test.js) verifies state
-- with a raw `pg` client (RLS doesn't apply to a direct Postgres
-- connection) and exercises writes only through Edge Functions, which use
-- serviceRoleClient() — the service-role key bypasses RLS entirely at the
-- connection level. Nothing in this project's test suite had ever run the
-- actual anon-key + user-JWT SELECT the mobile app's useGroups/
-- useGroupInfo/useGroupMembers/useGroupMessages hooks use, so this was
-- never once exercised the way a real user's phone exercises it — added a
-- regression test below (group-rls-select-function... see
-- supabase/tests/group-rls-recursion.test.js) precisely to close that gap
-- permanently, not just for this bug.
--
-- Fix (the standard, Supabase-documented pattern for this exact class of
-- recursion): a small SECURITY DEFINER helper that answers "is this user a
-- member of this group" via a query that does NOT go through
-- group_members' own RLS policy at all — a SECURITY DEFINER function runs
-- with its *owner's* privileges (the migration-applying `postgres` role in
-- this project, which has BYPASSRLS), so its internal query sidesteps the
-- self-reference entirely and the recursion never starts. All three
-- policies now call this function instead of embedding the raw self-join
-- inline.
--
-- Deliberate, narrow exception to CLAUDE.md rule #11's "revoke from
-- public/anon/authenticated, grant only to service_role": that rule exists
-- to stop a client from directly *mutating* money/state by calling a
-- SECURITY DEFINER function with the anon key. This function is the
-- opposite shape — a read-only, side-effect-free boolean check
-- (`stable`, no writes) that exists *specifically* to be invoked by
-- `authenticated` during normal RLS policy evaluation on every ordinary
-- SELECT; revoking authenticated's execute here would make every group
-- read fail exactly the way this migration fixes, just with a permission
-- error instead of a recursion error. Not granted to `anon` — an
-- unauthenticated caller has no legitimate reason to probe group
-- membership at all.

create function public.fn_is_group_member(p_group_thread_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_user_id
  );
$$;

revoke execute on function public.fn_is_group_member(uuid, uuid) from public, anon;
grant execute on function public.fn_is_group_member(uuid, uuid) to authenticated;

drop policy group_members_select_fellow_member on public.group_members;
create policy group_members_select_fellow_member on public.group_members
  for select
  to authenticated
  using (fn_is_group_member(group_thread_id, auth.uid()));

drop policy group_threads_select_member on public.group_threads;
create policy group_threads_select_member on public.group_threads
  for select
  to authenticated
  using (fn_is_group_member(id, auth.uid()));

drop policy group_messages_select_member on public.group_messages;
create policy group_messages_select_member on public.group_messages
  for select
  to authenticated
  using (fn_is_group_member(group_thread_id, auth.uid()));
