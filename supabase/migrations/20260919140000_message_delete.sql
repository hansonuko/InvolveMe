-- Delete message — delete-for-me and delete-for-everyone (punch-list item
-- 5, 2026-09-19), same WhatsApp-parity posture message editing already
-- established (20260919100000_message_editing.sql): this sits directly on
-- top of the escrow lifecycle, so read docs/03-ECONOMY-LEDGER.md /
-- docs/06-SECURITY-FRAUD-LOOPHOLES.md's spirit before assuming "delete"
-- means what it does in a free chat app.
--
-- Two genuinely different operations, same as WhatsApp:
--
-- 1. Delete for me — purely a per-viewer visibility hide. Never touches
--    `messages` at all, never touches money, available to *either*
--    participant, on *any* message regardless of status or age (there is
--    no fraud surface here: hiding a message from your own view can't
--    change what was charged or who got paid). Modeled as a real table
--    (`message_deletions`), not a local-only client flag, so it survives
--    reinstall/relogin the same way every other piece of this app's state
--    does — no linked-devices/multi-device sync exists yet
--    (docs/12-LINKED-DEVICES-WEB-SCOPING.md, on hold), so "survives
--    relogin on the same phone" is the honest scope for now.
--
-- 2. Delete for everyone — sender-only, within a time window (new config
--    `message_delete_window_minutes`, default 60 — WhatsApp's own
--    original delete-for-everyone window before it was later extended;
--    a real-world precedent, not an arbitrary pick, same reasoning
--    message_edit_window_minutes's own comment gives). Unlike editing,
--    this is deliberately *not* gated on `status = 'escrowed'` — deleting
--    can't be used to claw back or inflate value the way editing-after-
--    the-fact could (that's what the whole no-cost-increase rule in
--    fn_edit_message exists to prevent), so there's no reason to block it
--    once a message has settled. The credits/escrow/ledger trail is
--    completely untouched either way — deleting content never refunds,
--    never re-bills, never rewrites a single ledger_entries row, matching
--    CLAUDE.md rule #4's append-only posture applied here to what the
--    *content* deletion is even allowed to reach. Overwrites `body` to
--    empty and sets `deleted_for_everyone` so the tombstone is genuine
--    (the original text isn't recoverable through the app afterward,
--    same as real WhatsApp) — no separate "restore" path exists, same as
--    the product it's matching.

alter table public.messages
  add column deleted_for_everyone boolean not null default false;

insert into public.pricing_config (key, value, currency, description) values
  ('message_delete_window_minutes', 60, 'NGN', 'How long after sending a message can still be deleted for everyone (docs/03-ECONOMY-LEDGER.md, punch-list item 5) - WhatsApp''s own original delete-for-everyone window.')
on conflict (key, currency) do nothing;

create table public.message_deletions (
  message_id uuid not null references public.messages (id),
  user_id uuid not null references public.users (id),
  deleted_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create index message_deletions_user_id_idx on public.message_deletions (user_id);

alter table public.message_deletions enable row level security;

-- Same "read what's yours, no client writes at all" posture every other
-- money/message-adjacent table in this project uses — every write goes
-- through fn_delete_message_for_me (SECURITY DEFINER) below.
create policy message_deletions_select_own on public.message_deletions
  for select
  to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- fn_delete_message_for_me — either participant, any message, any time.
-- =============================================================================

create function public.fn_delete_message_for_me(p_message_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
begin
  select * into v_message from messages where id = p_message_id;
  if not found then
    raise exception 'message_not_found';
  end if;

  if not exists (
    select 1 from threads
    where id = v_message.thread_id
      and (participant_a = p_user_id or participant_b = p_user_id)
  ) then
    raise exception 'not_a_participant';
  end if;

  insert into message_deletions (message_id, user_id)
  values (p_message_id, p_user_id)
  on conflict (message_id, user_id) do nothing;
end;
$$;

revoke execute on function public.fn_delete_message_for_me(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_delete_message_for_me(uuid, uuid) to service_role;

-- =============================================================================
-- fn_delete_message_for_everyone — sender-only, within the delete window.
-- =============================================================================

create function public.fn_delete_message_for_everyone(p_message_id uuid, p_sender_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
  v_window_minutes bigint;
begin
  select * into v_message from messages where id = p_message_id for update;
  if not found then
    raise exception 'message_not_found';
  end if;

  if v_message.sender_id <> p_sender_id then
    raise exception 'not_the_sender';
  end if;

  if v_message.deleted_for_everyone then
    raise exception 'already_deleted';
  end if;

  select value into v_window_minutes from pricing_config where key = 'message_delete_window_minutes';
  if now() > v_message.created_at + make_interval(mins => v_window_minutes::integer) then
    raise exception 'delete_window_expired';
  end if;

  update messages
  set body = '', deleted_for_everyone = true
  where id = p_message_id;
end;
$$;

revoke execute on function public.fn_delete_message_for_everyone(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_delete_message_for_everyone(uuid, uuid) to service_role;
