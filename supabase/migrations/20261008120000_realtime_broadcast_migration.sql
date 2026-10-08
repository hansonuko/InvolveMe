-- Migrates every chat/wallet/thread/presence Realtime subscription from
-- `postgres_changes` (Postgres logical replication, re-evaluated per active
-- subscriber on every single row change) to Supabase's Broadcast primitive
-- (`realtime.broadcast_changes()` fired from a trigger, authorized via RLS
-- on `realtime.messages`), per Supabase's own documented scaling guidance:
-- Postgres Changes performs one authorization check PER SUBSCRIBER on every
-- change, so throughput degrades with subscriber count rather than write
-- rate, and processes changes on a single thread to preserve ordering —
-- Broadcast is Supabase's recommended mechanism once concurrent subscribers
-- on the same table meaningfully exceed a few thousand. docs/01-ARCHITECTURE.md
-- §4 is updated in the same change to describe this.
--
-- Nothing changes about WHO can see WHAT. Every RLS policy below on
-- realtime.messages was written to be the exact equivalent of the
-- underlying table's own existing SELECT policy (verified directly against
-- live pg_policy definitions before writing each mirror, not assumed):
--   messages        -> messages_select_participant
--   group_messages  -> group_messages_select_member (fn_is_group_member)
--   wallets         -> wallets_select_own
--   topups          -> topups_select_own
--   threads         -> threads_select_participant
--   users (presence)-> users_select_own_or_thread_partner
--
-- Client-side change lives entirely in apps/mobile/lib/realtimeChannel.ts.
-- Every call site (messages.ts, threads.ts, groups.ts, wallet.ts,
-- thread/[id].tsx) keeps calling useRealtimeTableChanges(topic, config,
-- onChange) with the exact same signature; the hook's internals now
-- subscribe to `broadcast` on a private channel instead of
-- `postgres_changes` and translate the broadcast payload shape back into
-- the same {eventType, new, old} shape every caller already handles.
--
-- Two pairs of call sites (useWallets/useLedgerEntries, useThreads/
-- useTotalUnreadCount) used to subscribe to the same table+filter under two
-- *different* topic strings, deliberately, per their own comments — purely
-- to avoid sharing a postgres_changes publication subscription across two
-- logically-separate consumers. That reasoning is specific to
-- postgres_changes' publication mechanism, which Broadcast has no
-- equivalent of (there is no "publication" to join — just a trigger), so
-- both pairs are collapsed onto one shared topic string each here
-- (`wallets:<user_id>`, `threads:<user_id>`) — one broadcast per change
-- instead of two, which is strictly a scaling win with no behavior change
-- (the shared, refcounted channel registry in realtimeChannel.ts already
-- lets multiple independent listeners subscribe to one topic correctly).

-- =============================================================================
-- 1. Helper: safely pull the uuid suffix off a 'prefix:<uuid>' topic
-- string, scoped to one prefix at a time. Returns null (never raises) for a
-- topic that doesn't match the prefix, or whose suffix isn't a real uuid,
-- so a client sending a malformed or foreign topic string just fails every
-- policy's check cleanly rather than raising inside the authorization
-- transaction Realtime runs on every channel join.
-- =============================================================================

create function public.fn_realtime_topic_uuid(p_prefix text)
returns uuid
language plpgsql
stable
set search_path to 'public'
as $$
declare
  v_topic text;
begin
  v_topic := realtime.topic();
  if v_topic is null or v_topic not like (p_prefix || ':%') then
    return null;
  end if;
  return substring(v_topic from length(p_prefix) + 2)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

-- Not SECURITY DEFINER (does no table access, needs no elevated privilege)
-- so CLAUDE.md rule #11's revoke-from-public dance doesn't apply — it's
-- plain STABLE SQL logic, safe for any role to call, and every role that
-- evaluates a realtime.messages RLS policy needs to be able to call it.
grant execute on function public.fn_realtime_topic_uuid(text) to authenticated;

-- =============================================================================
-- 2. Realtime Authorization — one SELECT policy per topic prefix on
-- realtime.messages, each the mirror of the equivalent table's own RLS.
-- =============================================================================

create policy realtime_broadcast_messages_thread_participant
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from public.threads t
    where t.id = public.fn_realtime_topic_uuid('messages')
      and (t.participant_a = auth.uid() or t.participant_b = auth.uid())
  )
);

create policy realtime_broadcast_group_messages_member
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and public.fn_is_group_member(public.fn_realtime_topic_uuid('group-messages'), auth.uid())
);

create policy realtime_broadcast_wallets_own
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and public.fn_realtime_topic_uuid('wallets') = auth.uid()
);

create policy realtime_broadcast_topups_own
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and exists (
    select 1 from public.topups tp
    where tp.id = public.fn_realtime_topic_uuid('topups')
      and tp.user_id = auth.uid()
  )
);

create policy realtime_broadcast_threads_own
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and public.fn_realtime_topic_uuid('threads') = auth.uid()
);

create policy realtime_broadcast_user_last_seen
on "realtime"."messages"
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (
    public.fn_realtime_topic_uuid('user-last-seen') = auth.uid()
    or exists (
      select 1 from public.threads t
      where (t.participant_a = auth.uid() and t.participant_b = public.fn_realtime_topic_uuid('user-last-seen'))
         or (t.participant_b = auth.uid() and t.participant_a = public.fn_realtime_topic_uuid('user-last-seen'))
    )
  )
);

-- =============================================================================
-- 3. Trigger functions + triggers. Each is SECURITY DEFINER SET search_path
-- = '' (the pattern Supabase's own docs specify) for a real, verified
-- reason, not belt-and-braces: `users.last_seen_at` is updated directly by
-- an `authenticated` client (users_update_own RLS policy, no RPC involved),
-- so that trigger fires under the `authenticated` role's own privileges —
-- without SECURITY DEFINER it would need an explicit INSERT grant on
-- realtime.messages for `authenticated` to succeed at all. Every other
-- table here is only ever written through an existing SECURITY DEFINER RPC
-- function already owned by the migration role, so this is also just
-- consistent, not newly load-bearing, for those five.
--
-- Each is `RETURNS trigger`, which Postgres will only ever invoke via a
-- real `CREATE TRIGGER ... EXECUTE FUNCTION` firing — calling one directly
-- (`select fn_broadcast_x_changes()`) is rejected by Postgres itself
-- ("trigger functions can only be called as triggers") regardless of
-- EXECUTE grants, which is what makes it safe to grant `authenticated`
-- EXECUTE here without reopening CLAUDE.md rule #11's actual concern (a
-- client-invokable RPC call) — there is no such call surface for a
-- trigger-typed function. Granted explicitly anyway, rather than relying on
-- this project's own default-grant quirk (rule #11's whole backstory).
-- =============================================================================

create function public.fn_broadcast_messages_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'messages:' || coalesce(new.thread_id, old.thread_id)::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

create trigger broadcast_messages_changes
after insert or update on public.messages
for each row execute function public.fn_broadcast_messages_changes();

grant execute on function public.fn_broadcast_messages_changes() to authenticated, service_role;

create function public.fn_broadcast_group_messages_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'group-messages:' || new.group_thread_id::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

create trigger broadcast_group_messages_changes
after insert on public.group_messages
for each row execute function public.fn_broadcast_group_messages_changes();

grant execute on function public.fn_broadcast_group_messages_changes() to authenticated, service_role;

create function public.fn_broadcast_wallets_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'wallets:' || coalesce(new.user_id, old.user_id)::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

-- No delete: wallets are never deleted (confirmed — no `delete from
-- wallets` anywhere in supabase/migrations), only ever inserted once at
-- signup and updated via balance-mutating SECURITY DEFINER functions.
create trigger broadcast_wallets_changes
after insert or update on public.wallets
for each row execute function public.fn_broadcast_wallets_changes();

grant execute on function public.fn_broadcast_wallets_changes() to authenticated, service_role;

create function public.fn_broadcast_topups_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'topups:' || new.id::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

create trigger broadcast_topups_changes
after update on public.topups
for each row execute function public.fn_broadcast_topups_changes();

grant execute on function public.fn_broadcast_topups_changes() to authenticated, service_role;

-- threads affects two different users at once (the two participants), so
-- unlike every other trigger here this one broadcasts twice — once to each
-- participant's own `threads:<user_id>` topic — since a single change can
-- be relevant to two different subscribers who each only ever watch their
-- own topic (mirrors threads_select_participant's own OR-of-two-columns
-- shape, just expressed as two sends instead of one predicate).
create function public.fn_broadcast_threads_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_participant_a uuid := coalesce(new.participant_a, old.participant_a);
  v_participant_b uuid := coalesce(new.participant_b, old.participant_b);
begin
  perform realtime.broadcast_changes(
    'threads:' || v_participant_a::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  perform realtime.broadcast_changes(
    'threads:' || v_participant_b::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

-- Includes delete: fn_fix_duplicate_thread_creation's dedup cleanup really
-- does `delete from threads` (20260927150000_fix_duplicate_thread_creation.sql),
-- unlike messages/wallets.
create trigger broadcast_threads_changes
after insert or update or delete on public.threads
for each row execute function public.fn_broadcast_threads_changes();

grant execute on function public.fn_broadcast_threads_changes() to authenticated, service_role;

create function public.fn_broadcast_users_last_seen_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.broadcast_changes(
    'user-last-seen:' || new.id::text,
    tg_op, tg_op, tg_table_name, tg_table_schema, new, old
  );
  return null;
end;
$$;

-- WHEN clause keeps this from firing on every unrelated `users` column
-- update (display name, avatar, phone, ...) — only the two columns the one
-- real subscriber (user-last-seen:<partnerId>) actually reads.
create trigger broadcast_users_last_seen_changes
after update on public.users
for each row
when (
  old.last_seen_at is distinct from new.last_seen_at
  or old.last_seen_enabled is distinct from new.last_seen_enabled
)
execute function public.fn_broadcast_users_last_seen_changes();

grant execute on function public.fn_broadcast_users_last_seen_changes() to authenticated, service_role;
