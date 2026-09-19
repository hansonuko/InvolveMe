-- Real bug fix: the "Read <time>" shown on a sent message was derived
-- live from the partner's thread-wide read cursor
-- (threads.participant_*_last_read_at), applied identically to every
-- message the cursor had passed. Since the cursor only ever moves
-- forward and is overwritten on every subsequent read, an older message's
-- displayed read time kept jumping forward to match whatever the cursor's
-- *latest* value happened to be — e.g. a message actually read at 2:00pm
-- would show "Read 3:52pm" once the partner opened the thread again later
-- and the cursor advanced, even though that specific message was read
-- hours earlier. The cursor itself stays exactly as-is for unread-count
-- purposes (thread_unread_counts) — this adds a second, complementary
-- per-message timestamp for the read-time *display* specifically.

alter table public.messages add column read_at timestamptz;

drop function public.fn_mark_thread_read(uuid, uuid);

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

  -- Stamps the real moment each of the *other* participant's messages was
  -- actually first read, frozen here on — `read_at is null` means this
  -- only ever sets it once per message, on whichever call to this
  -- function first happens after that message was sent; a later call
  -- (reading newer messages) never touches an already-stamped one.
  update messages
    set read_at = now()
    where thread_id = p_thread_id
      and sender_id <> p_caller_id
      and read_at is null;
end;
$$;

revoke execute on function public.fn_mark_thread_read(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_mark_thread_read(uuid, uuid) to service_role;
