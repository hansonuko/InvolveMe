-- Settings expansion: real blocking (a genuine gap — threads.is_blocked
-- and its enforcement in fn_send_message already existed, but nothing
-- ever *set* it), user reports (app-store review requirement per
-- docs/07-COMPLIANCE-LEGAL.md, previously missing entirely), read
-- receipts (a privacy toggle over the read-cursor data already built for
-- unread tracking, migration 20260914080000_thread_read_cursor.sql), push
-- notification device tokens, and account-deletion requests (a support
-- flow, not instant self-service delete — this app custodies real money,
-- a wallet balance can't just vanish on a tap).

-- =============================================================================
-- Blocking — replaces the boolean `is_blocked` with `blocked_by`, which
-- records *who* blocked the thread. The boolean alone couldn't support a
-- "Blocked contacts" list (no way to tell which threads *you* blocked vs.
-- threads where the *other* participant blocked you) or prevent a blocked
-- person from unilaterally unblocking themselves.
-- =============================================================================

alter table public.threads add column blocked_by uuid references public.users(id);
alter table public.threads drop column is_blocked;

create function public.fn_set_thread_blocked(p_thread_id uuid, p_caller_id uuid, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
begin
  select * into v_thread from threads where id = p_thread_id for update;
  if not found then
    raise exception 'thread_not_found';
  end if;

  if p_caller_id not in (v_thread.participant_a, v_thread.participant_b) then
    raise exception 'not_a_participant';
  end if;

  if p_blocked then
    -- Idempotent: if already blocked (by either party), leave blocked_by
    -- as whoever set it first rather than overwriting.
    if v_thread.blocked_by is null then
      update threads set blocked_by = p_caller_id where id = p_thread_id;
    end if;
  else
    if v_thread.blocked_by is null then
      return; -- already unblocked, no-op
    end if;
    if v_thread.blocked_by <> p_caller_id then
      -- The person who got blocked can't unblock themselves.
      raise exception 'not_the_blocker';
    end if;
    update threads set blocked_by = null where id = p_thread_id;
  end if;
end;
$$;

revoke execute on function public.fn_set_thread_blocked(uuid, uuid, boolean) from public;
grant execute on function public.fn_set_thread_blocked(uuid, uuid, boolean) to service_role;

-- fn_send_message / fn_release_escrow's guard-frozen-wallets version both
-- checked `v_thread.is_blocked` — re-created here (create or replace,
-- forward-only per CLAUDE.md) against `blocked_by is not null` instead.
-- fn_release_escrow's own block check (guard_frozen_wallets.sql) didn't
-- reference is_blocked at all, only fn_send_message did.
create or replace function public.fn_send_message(p_thread_id uuid, p_sender_id uuid, p_body text)
returns table (
  message_id uuid,
  credits_charged bigint,
  word_count integer,
  status text,
  payer_balance_after bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_is_reply boolean;
  v_word_count integer;
  v_block_size bigint;
  v_base_credits bigint;
  v_max_words bigint;
  v_credits bigint;
  v_refund_hours bigint;
  v_payer_wallet_id uuid;
  v_payer_balance bigint;
  v_payer_frozen boolean;
  v_message_id uuid;
begin
  select * into v_thread from threads where id = p_thread_id for update;
  if not found then
    raise exception 'thread_not_found';
  end if;

  if p_sender_id not in (v_thread.participant_a, v_thread.participant_b) then
    raise exception 'not_a_participant';
  end if;

  if v_thread.blocked_by is not null then
    raise exception 'thread_blocked';
  end if;

  v_is_reply := (p_sender_id = v_thread.participant_b);

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 then
    raise exception 'empty_message';
  end if;

  select value into v_block_size from pricing_config where key = 'message_word_block_size';
  select value into v_base_credits from pricing_config where key = 'message_base_credits';
  select value into v_max_words from pricing_config where key = 'message_max_words';
  select value into v_refund_hours from pricing_config where key = 'escrow_unanswered_refund_hours';

  if v_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
  end if;

  v_credits := (v_base_credits * greatest(ceil(v_word_count::numeric / v_block_size), 1))::bigint;

  select id, balance, is_frozen into v_payer_wallet_id, v_payer_balance, v_payer_frozen
  from wallets
  where user_id = v_thread.participant_a and kind = 'topup_credit'
  for update;

  if v_payer_frozen then
    raise exception 'wallet_frozen';
  end if;

  if v_payer_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_payer_balance;
  end if;

  insert into messages (thread_id, sender_id, body, word_count, credits_charged, status)
  values (p_thread_id, p_sender_id, p_body, v_word_count, v_credits, 'escrowed')
  returning id into v_message_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_payer_wallet_id, -v_credits, 'message_debit', 'message', v_message_id);

  insert into escrows (thread_id, message_id, payer_id, payee_id, credits_held, status, expires_at)
  values (
    p_thread_id, v_message_id, v_thread.participant_a, v_thread.participant_b,
    v_credits, 'pending', now() + make_interval(hours => v_refund_hours::integer)
  );

  update threads set last_message_at = now() where id = p_thread_id;

  if v_is_reply then
    perform fn_release_escrow(p_thread_id);
  end if;

  select balance into v_payer_balance from wallets where id = v_payer_wallet_id;

  return query select v_message_id, v_credits, v_word_count, 'escrowed'::text, v_payer_balance;
end;
$$;

-- =============================================================================
-- Read receipts — a privacy toggle over data that already exists (the
-- read cursor built for unread counts). Turning it off doesn't stop the
-- cursor itself from being written (the owner's own unread-badge
-- accuracy shouldn't depend on whether they share it with others — same
-- as WhatsApp, where disabling read receipts only stops *sending* the
-- signal to others, not your own local unread state) — it stops other
-- participants' clients from being *shown* it. Enforced client-side by
-- checking the partner's own flag before rendering a "read" indicator;
-- readable via the existing (documented, loose) users SELECT policy that
-- already exposes a thread partner's row.
-- =============================================================================

alter table public.users add column read_receipts_enabled boolean not null default true;
grant update (read_receipts_enabled) on public.users to authenticated;

-- =============================================================================
-- Push notification device tokens. One row per installed-app-instance
-- (a user may have more than one device); `token` is the primary key
-- since an Expo push token is already unique per app install. Client
-- writes its own rows directly (upsert/delete) — plain RLS, no
-- SECURITY DEFINER function needed, since a `with check` on user_id is
-- all the correctness this table needs (same posture as the two
-- report/request tables below: a narrow, self-scoped insert/delete is a
-- completely different risk class from anything wallet-shaped).
-- =============================================================================

create table public.push_tokens (
  token text primary key,
  user_id uuid not null references public.users(id),
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now()
);

create index push_tokens_user_id_idx on public.push_tokens (user_id);

alter table public.push_tokens enable row level security;

create policy push_tokens_owner_all on public.push_tokens
  for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- =============================================================================
-- User reports — the "reporting system" docs/07-COMPLIANCE-LEGAL.md §4
-- names as an app-store review requirement, previously entirely missing.
-- Insert-only from the client (own reports only); no SELECT grant to
-- `authenticated` at all — reports are for ops/admin review via the
-- service role or Studio, never readable by the reporting or reported
-- user through the app.
-- =============================================================================

create table public.user_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.users(id),
  reported_user_id uuid not null references public.users(id),
  thread_id uuid references public.threads(id),
  reason text not null,
  details text,
  created_at timestamptz not null default now()
);

alter table public.user_reports enable row level security;

create policy user_reports_insert_own on public.user_reports
  for insert
  to authenticated
  with check (auth.uid() = reporter_id);

-- =============================================================================
-- Account deletion requests — a support-request queue, not instant
-- self-service delete. This app custodies real money (topup_credit,
-- earnings_pending, withdrawable_cash); a self-service delete button
-- can't be allowed to make a real balance simply disappear, and what
-- should actually happen (force a withdrawal first? escheat after a
-- notice period? per CLAUDE.md's regulatory posture, this needs an
-- actual policy decision, not code) isn't decided yet. This table is
-- just the honest capture mechanism — same insert-only-own posture as
-- user_reports — until that policy exists.
-- =============================================================================

create table public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  reason text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  created_at timestamptz not null default now()
);

alter table public.account_deletion_requests enable row level security;

create policy account_deletion_requests_select_own on public.account_deletion_requests
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy account_deletion_requests_insert_own on public.account_deletion_requests
  for insert
  to authenticated
  with check (auth.uid() = user_id);
