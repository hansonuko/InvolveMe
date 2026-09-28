-- Real, live, user-reported bug: a second, disconnected "MoonBerry" thread
-- appeared, empty, in the chat list. Root cause, confirmed live: this was
-- a documented-but-never-fixed gap from the E2EE build (session 35's own
-- residual-gaps note) — `threads_participants_unique unique (participant_a,
-- participant_b)` only constrains one ordering of the pair, and
-- `fn_start_thread`'s own existing-thread lookup only ever checked that
-- same one ordering. When the OTHER participant's client called
-- fn_start_thread(payer=them, payee=us) against a thread that already
-- existed the other way around, the lookup found nothing and created a
-- second, fully independent thread — same two people, completely separate
-- message history, separate payer_id, separate everything. Confirmed via a
-- live query: exactly one such pair exists in the whole database (Vicky/
-- Uko), the extra thread has zero messages/escrows/reports/payer-history
-- rows (safe to remove outright, not a data-loss risk), and the real
-- thread (31 messages, 31 escrows, e2ee-active) is untouched.

-- Step 1: remove the one confirmed-empty duplicate. Scoped to genuinely
-- zero-content threads only — this is a one-time cleanup for the exact
-- case found live, not a general "collapse duplicates" tool (a duplicate
-- pair where BOTH threads have real messages/money would need a real
-- merge decision, not an automatic delete, and none exist today).
do $$
declare
  v_dupe record;
begin
  for v_dupe in
    select t.id
    from threads t
    join (
      select least(participant_a, participant_b) as p1, greatest(participant_a, participant_b) as p2
      from threads
      group by 1, 2
      having count(*) > 1
    ) pairs on least(t.participant_a, t.participant_b) = pairs.p1
      and greatest(t.participant_a, t.participant_b) = pairs.p2
    where not exists (select 1 from messages m where m.thread_id = t.id)
      and not exists (select 1 from escrows e where e.thread_id = t.id)
      and not exists (select 1 from user_reports r where r.thread_id = t.id)
      and not exists (select 1 from thread_payer_history h where h.thread_id = t.id)
  loop
    delete from threads where id = v_dupe.id;
  end loop;
end $$;

-- Step 2: close the gap permanently at the schema level — defense in
-- depth, independent of fn_start_thread staying correct forever. Safe to
-- add now that step 1 guarantees no existing duplicate pair remains.
create unique index threads_participant_pair_unique
  on public.threads (least(participant_a, participant_b), greatest(participant_a, participant_b));

-- Step 3: the actual application-level fix — fn_start_thread now checks
-- BOTH orderings before deciding a thread doesn't exist yet. Everything
-- else about this function (self-thread rejection, payer_id defaulting to
-- the initiator on a genuinely new thread) is unchanged; an existing
-- thread found via the reverse ordering keeps its own payer_id exactly as
-- it already was — payer_id is a separate, mutable field from
-- participant_a/b (docs/18 §C1), never touched by this lookup either way.
create or replace function public.fn_start_thread(p_payer_id uuid, p_payee_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread_id uuid;
begin
  if p_payer_id = p_payee_id then
    raise exception 'cannot_thread_with_self';
  end if;

  select id into v_thread_id
  from threads
  where (participant_a = p_payer_id and participant_b = p_payee_id)
     or (participant_a = p_payee_id and participant_b = p_payer_id);

  if not found then
    insert into threads (participant_a, participant_b, payer_id)
    values (p_payer_id, p_payee_id, p_payer_id)
    returning id into v_thread_id;
  end if;

  return v_thread_id;
end;
$$;

revoke execute on function public.fn_start_thread(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_start_thread(uuid, uuid) to service_role;
