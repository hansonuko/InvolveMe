-- Per-thread read cursor + unread counts. Flagged in
-- docs/08-BUILD-PHASES-ROADMAP.md's deferred list when the 2026-09-13
-- wine-rebrand mockup assumed this already existed — it didn't (`threads`
-- had no concept of "who has read what"). No money moves here; this is
-- read-state only, so none of CLAUDE.md's ledger/locking machinery
-- applies, but the same "no client writes past a validating function"
-- posture does, for the reason explained on fn_mark_thread_read below.
--
-- Cursor lives as two columns on `threads` (one per participant) rather
-- than a separate `thread_reads` table — this schema's threads are
-- strictly 1:1 (docs/02-DATA-MODEL.md), so a generic per-user-per-thread
-- table would just be `threads` with extra steps. Group chats, if/when
-- `group_chat_enabled` ever flips on, would need their own version of
-- this (a `group_members.last_read_at` column fits that N-member shape
-- better) — not scoped here, not needed while that feature is gated off.

alter table public.threads
  add column participant_a_last_read_at timestamptz,
  add column participant_b_last_read_at timestamptz;

-- =============================================================================
-- thread_unread_counts — per-caller unread count per thread. `security_invoker
-- = true` is load-bearing, not a stylistic default: without it, a view
-- created by a privileged migration role runs with *that* role's
-- row-level-security context, not the querying user's — silently exposing
-- every thread's unread count to every authenticated caller regardless of
-- membership. With it, `auth.uid()` and the underlying `threads`/`messages`
-- RLS policies apply exactly as they would for a direct query, so scoping
-- to "your own threads" falls out of existing policy, not new logic here.
--
-- A thread with zero messages yet has no unread count row at all (the
-- inner join produces nothing to count) — correct, since "unread" only
-- means something once there's something to have read.
-- =============================================================================

create view public.thread_unread_counts
with (security_invoker = true)
as
select
  t.id as thread_id,
  count(m.id) filter (
    where m.sender_id <> auth.uid()
      and m.created_at > coalesce(
        case
          when t.participant_a = auth.uid() then t.participant_a_last_read_at
          when t.participant_b = auth.uid() then t.participant_b_last_read_at
        end,
        'epoch'::timestamptz
      )
  ) as unread_count
from public.threads t
join public.messages m on m.thread_id = t.id
where t.participant_a = auth.uid() or t.participant_b = auth.uid()
group by t.id;

grant select on public.thread_unread_counts to authenticated;

-- =============================================================================
-- fn_mark_thread_read — sets the *caller's own* read cursor on a thread
-- they're actually a participant of. A SECURITY DEFINER function rather
-- than a client-writable RLS policy + column grant on purpose: Postgres
-- column-level grants aren't conditional on which participant slot the
-- caller occupies, so a raw "authenticated may UPDATE either
-- participant_*_last_read_at column, RLS restricts which rows" setup
-- would let participant A clear participant B's unread badge on a shared
-- row (RLS's row check would pass since A legitimately owns the row; only
-- a column-aware check like this function's if/elsif actually prevents
-- touching the other participant's cursor). Same "every write through a
-- validating function" posture the money functions use, applied here for
-- correctness rather than for CLAUDE.md's financial-logic rule specifically.
-- =============================================================================

create function public.fn_mark_thread_read(p_thread_id uuid, p_caller_id uuid)
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
    update threads set participant_a_last_read_at = now() where id = p_thread_id;
  elsif p_caller_id = v_thread.participant_b then
    update threads set participant_b_last_read_at = now() where id = p_thread_id;
  else
    raise exception 'not_a_participant';
  end if;
end;
$$;

revoke execute on function public.fn_mark_thread_read(uuid, uuid) from public;
grant execute on function public.fn_mark_thread_read(uuid, uuid) to service_role;
