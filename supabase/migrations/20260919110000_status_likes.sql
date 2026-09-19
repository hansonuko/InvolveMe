-- Punch-list item 4a (2026-09-19): a status "like" — a lightweight, free
-- reaction, matching WhatsApp's own status-like behavior. Deliberately
-- NOT a message and NOT gated behind fn_send_message: this app's whole
-- economic model charges for messages (docs/03-ECONOMY-LEDGER.md §4), but
-- a like is a much smaller-weight signal than a message the same way a
-- view is — status_views already established the "free, no ledger
-- involvement, direct client write" precedent for exactly this kind of
-- lightweight interaction, and this table follows the same shape.
--
-- Direct client INSERT/DELETE (no SECURITY DEFINER function), same
-- reasoning useDeleteStatus's own comment already gives for status
-- deletion: RLS's WITH CHECK can fully express the one real constraint
-- here (you can only like a status you're actually allowed to see - the
-- exact same thread-partner/not-expired condition
-- status_updates_select_visible_to_thread_partner already encodes), so
-- there's no cross-table logic a function would be needed for.

create table public.status_likes (
  status_id uuid not null references public.status_updates(id) on delete cascade,
  liker_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (status_id, liker_id)
);

alter table public.status_likes enable row level security;

-- Mirrors status_updates_select_visible_to_thread_partner exactly - you
-- can only like a status you could actually see in the first place
-- (poster is a non-blocked thread partner, status not expired), and you
-- can always see/manage your own likes.
create policy status_likes_insert_own on public.status_likes
  for insert
  with check (
    liker_id = auth.uid()
    and exists (
      select 1 from public.status_updates su
      join public.threads t
        on (t.participant_a = auth.uid() and t.participant_b = su.user_id)
        or (t.participant_b = auth.uid() and t.participant_a = su.user_id)
      where su.id = status_likes.status_id
        and su.expires_at > now()
        and t.blocked_by is null
    )
  );

create policy status_likes_delete_own on public.status_likes
  for delete
  using (liker_id = auth.uid());

create policy status_likes_select_own on public.status_likes
  for select
  using (liker_id = auth.uid());

-- Same "poster can see every row on their own statuses" posture
-- status_views_select_as_poster already established for view counts -
-- sets up a future "who liked this" list with no further RLS change
-- needed, same precedent that policy's own migration comment names.
create policy status_likes_select_as_poster on public.status_likes
  for select
  using (
    exists (
      select 1 from public.status_updates su
      where su.id = status_likes.status_id and su.user_id = auth.uid()
    )
  );
