-- Per-thread mute (docs/10-UX-REFINEMENT-BACKLOG.md Batch G) — two
-- independent boolean columns, one per participant slot, same pattern
-- `participant_a_last_read_at`/`participant_b_last_read_at`
-- (20260914080000_thread_read_cursor.sql) already established for
-- per-participant thread state. Deliberately NOT modeled like
-- `blocked_by` (a single nullable column) — muting isn't a shared,
-- one-at-a-time state the way blocking is (only one party can have
-- blocked a thread at a time, and only they can unblock it); either or
-- both participants may independently mute the same thread, with no
-- "who muted first" precedence to track.

alter table public.threads
  add column muted_by_a boolean not null default false,
  add column muted_by_b boolean not null default false;

-- =============================================================================
-- fn_set_thread_muted — sets the *caller's own* mute flag on a thread
-- they're actually a participant of. Same reasoning fn_mark_thread_read's
-- header comment already gives for using a function instead of a raw
-- column grant: a plain "authenticated may UPDATE either muted_by_*
-- column, RLS restricts which rows" setup can't stop participant A from
-- muting (or unmuting) B's own notification preference on a shared row —
-- only a column-aware check like this function's if/elsif actually
-- prevents touching the other participant's flag.
-- =============================================================================

create function public.fn_set_thread_muted(p_thread_id uuid, p_caller_id uuid, p_muted boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
begin
  select * into v_thread from threads where id = p_thread_id;
  if not found then
    raise exception 'thread_not_found';
  end if;

  if p_caller_id = v_thread.participant_a then
    update threads set muted_by_a = p_muted where id = p_thread_id;
  elsif p_caller_id = v_thread.participant_b then
    update threads set muted_by_b = p_muted where id = p_thread_id;
  else
    raise exception 'not_a_participant';
  end if;
end;
$$;

revoke execute on function public.fn_set_thread_muted(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_set_thread_muted(uuid, uuid, boolean) to service_role;
