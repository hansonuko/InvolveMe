-- Free group messaging — ships group creation + sending for real, without
-- touching the money side at all. Decided 2026-09-18 (punch-list item 11):
-- docs/03-ECONOMY-LEDGER.md §10's paid billing model (fn_send_group_message,
-- migration 20260913200000_group_chats.sql) stays exactly as it was left —
-- built, tested, and kill-switched off (`group_chat_enabled = 0`) — because
-- it has a real, documented, unmitigated exploit (§10: "an attacker who
-- creates a group and controls (or colludes with) just one other member can
-- convert topup_credit into real withdrawable cash on every single message,
-- indefinitely"). That risk is entirely a property of the *paid* path
-- (owner_earning_credits, platform_take_credits, wallet/ledger writes) — it
-- doesn't exist at all if a group message never touches money. So this
-- migration adds a second, parallel send function that's free, not a
-- workaround for the kill switch: `fn_send_group_message_free` never reads
-- `group_chat_enabled`, never touches `wallets` or `ledger_entries`, and
-- always writes `credits_charged = 0`. `fn_send_group_message` itself is
-- untouched — when Phase 5's fraud infra lands and the product decision is
-- made to monetize groups, the client swaps which function it calls; the
-- already-tested paid path doesn't need to change at all.
--
-- Also adds `fn_create_group_thread` — per docs/02-DATA-MODEL.md's own
-- "still unresolved" list, nothing wrote `group_threads`/`group_members`
-- outside tests before this. No RLS INSERT policy on any of the three group
-- tables (same "no client writes, SECURITY DEFINER only" posture the
-- 2026-09-13 migration already established for group_messages) — this is
-- the only way either table gets written now.
--
-- Deliberately not built here, scoped as v2 (a group needs *a* creation
-- path before any of these are worth designing): leaving a group, removing
-- a member, renaming a group, adding members after creation, a group
-- avatar, and any group-size cap tuning beyond the flat constant below.

create function public.fn_create_group_thread(
  p_creator_id uuid,
  p_name text,
  p_member_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_member_ids uuid[];
  v_member_id uuid;
  v_group_id uuid;
  -- Arbitrary, not researched — a blast-radius limit on a brand-new write
  -- path, same posture credit_transfer_max_credits documents for its own
  -- cap: "raising it should be deliberate," not a number pulled from a
  -- specific product requirement.
  v_max_members constant integer := 100;
begin
  v_name := trim(both from p_name);
  if length(v_name) = 0 then
    raise exception 'group_name_required';
  end if;
  if length(v_name) > 60 then
    raise exception 'group_name_too_long';
  end if;

  -- Dedupe, and drop the creator if the client echoed them back in (they're
  -- always added below as the fixed owner/admin, never as a pickable
  -- member) and any null.
  select array_agg(distinct m) into v_member_ids
  from unnest(p_member_ids) as m
  where m is not null and m <> p_creator_id;

  if v_member_ids is null or array_length(v_member_ids, 1) = 0 then
    raise exception 'group_needs_members';
  end if;

  if array_length(v_member_ids, 1) + 1 > v_max_members then
    raise exception 'too_many_members: max % including the creator', v_max_members;
  end if;

  if exists (
    select 1 from unnest(v_member_ids) as m
    where not exists (select 1 from users where id = m)
  ) then
    raise exception 'member_not_found';
  end if;

  insert into group_threads (name, created_by)
  values (v_name, p_creator_id)
  returning id into v_group_id;

  insert into group_members (group_thread_id, user_id, role)
  values (v_group_id, p_creator_id, 'admin');

  foreach v_member_id in array v_member_ids loop
    insert into group_members (group_thread_id, user_id, role)
    values (v_group_id, v_member_id, 'member');
  end loop;

  return v_group_id;
end;
$$;

revoke execute on function public.fn_create_group_thread(uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.fn_create_group_thread(uuid, text, uuid[]) to service_role;

-- =============================================================================
-- fn_send_group_message_free — the free-era sibling of fn_send_group_message.
-- Deliberately duplicates that function's membership/word-count validation
-- rather than sharing code with it, so the paid function's own already-
-- tested behavior can never be accidentally changed by an edit made for the
-- free path (same "parallel, not shared, to contain blast radius" reasoning
-- the 2026-09-13 migration's own header comment gives for group_* being new
-- tables instead of extending threads/messages).
--
-- Reuses `message_max_words` (pricing_config) purely as a length cap, not a
-- price — keeps free and paid groups behaving identically on message length
-- without a second, redundant config key for the same number.
-- =============================================================================

create function public.fn_send_group_message_free(
  p_group_thread_id uuid,
  p_sender_id uuid,
  p_body text
)
returns table (
  message_id uuid,
  word_count integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_word_count integer;
  v_max_words bigint;
  v_message_id uuid;
  v_created_at timestamptz;
begin
  if not exists (select 1 from group_threads where id = p_group_thread_id) then
    raise exception 'group_not_found';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_sender_id
  ) then
    raise exception 'not_a_member';
  end if;

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 then
    raise exception 'empty_message';
  end if;

  select value into v_max_words from pricing_config where key = 'message_max_words';
  if v_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
  end if;

  insert into group_messages (
    group_thread_id, sender_id, body, word_count, credits_charged,
    owner_earning_credits, platform_take_credits
  )
  values (
    p_group_thread_id, p_sender_id, p_body, v_word_count, 0, 0, 0
  )
  returning id, group_messages.created_at into v_message_id, v_created_at;

  update group_threads set last_message_at = v_created_at where id = p_group_thread_id;

  return query select v_message_id, v_word_count, v_created_at;
end;
$$;

revoke execute on function public.fn_send_group_message_free(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_send_group_message_free(uuid, uuid, text) to service_role;

-- Live updates while a group-thread screen is open (mobile's
-- useGroupMessages), same mechanism messages/wallets/topups/credit_transfers
-- already use (20260913061202_enable_realtime_messages_wallets.sql) —
-- `group_messages` was never added when the table itself was created,
-- since nothing read it live until this pass.
alter publication supabase_realtime add table public.group_messages;

-- Group messages get the same content-moderation check every other
-- user-authored text in this app gets (docs/06-SECURITY-FRAUD-LOOPHOLES.md
-- §6) — the send-group-message Edge Function logs a block/flag here the
-- same way send-message/post-status already do. Drop + recreate the check
-- constraint, same approach the 2026-09-13 group-chats migration already
-- used for ledger_entries' own reason/ref_type vocabulary.
alter table public.moderated_content drop constraint moderated_content_content_type_check;
alter table public.moderated_content add constraint moderated_content_content_type_check
  check (content_type in ('message', 'status', 'group_message'));
