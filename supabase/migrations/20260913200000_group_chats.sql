-- Group chats — schema + fn_send_group_message, per the billing model
-- decided in docs/03-ECONOMY-LEDGER.md §10 and the schema sketched in
-- docs/02-DATA-MODEL.md's "Group threads" note. Built this session per
-- explicit request, but **not live**: `group_chat_enabled` (below) ships
-- at 0, and stays there until Phase 5's collusion-detection/velocity-limit
-- infra exists (docs/08-BUILD-PHASES-ROADMAP.md's Phase 5 gate bullet) —
-- this model has no reply-gate and no per-message cap, so it's held behind
-- a real kill switch, not just a comment saying "don't call this yet."
--
-- Billing model, in full (docs/03 §10):
--   - Any member pays the normal word-count message cost to post (same
--     formula/config keys as 1:1 messages — no separate group pricing tier).
--   - Settles immediately, no escrow — nothing in a broadcast channel maps
--     to "the recipient replied".
--   - 70/30 split (platform_group_message_take_bps, independently tunable
--     from platform_earning_take_bps/platform_transfer_take_bps) to the
--     group's fixed owner (group_threads.created_by) / platform.
--   - Self-post exception: if the sender IS the owner, no split happens at
--     all — the message still costs credits as normal, nobody earns
--     anything on it. This is a hard requirement (closes the trivial
--     single-account cash-out loop), not an optimization.
--
-- New tables, not an extension of threads/messages (docs/02's reasoning):
-- those two are 1:1-shaped throughout (fn_release_escrow assumes exactly
-- one payee) — forking that logic with `if is_group` branches would put
-- this much-less-tested code path inside the functions the real 1:1 money
-- path depends on. A parallel schema contains the blast radius instead.

create table public.group_threads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  avatar_url text,
  created_by uuid not null references public.users (id),
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_thread_id uuid not null references public.group_threads (id),
  user_id uuid not null references public.users (id),
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_thread_id, user_id)
);

create index group_members_user_id_idx on public.group_members (user_id);

create table public.group_messages (
  id uuid primary key default gen_random_uuid(),
  group_thread_id uuid not null references public.group_threads (id),
  sender_id uuid not null references public.users (id),
  body text not null,
  word_count integer not null,
  credits_charged bigint not null,
  -- Both 0 on a self-post (sender = group_threads.created_by) — see header
  -- comment. No `status`/escrow columns: this model settles immediately,
  -- there is no pending state to track.
  owner_earning_credits bigint not null default 0,
  platform_take_credits bigint not null default 0,
  created_at timestamptz not null default now()
);

create index group_messages_group_thread_id_created_at_idx
  on public.group_messages (group_thread_id, created_at);

alter table public.group_threads enable row level security;
alter table public.group_members enable row level security;
alter table public.group_messages enable row level security;

-- Same posture as threads/messages (docs/02-DATA-MODEL.md §2): read what
-- you're a member of, no client writes at all — every write is via
-- fn_send_group_message (SECURITY DEFINER) or, for membership, whatever
-- future group-creation/invite function is built alongside the UI (not
-- part of this pass — see docs/02's still-unresolved list).
create policy group_threads_select_member on public.group_threads
  for select
  to authenticated
  using (
    exists (
      select 1 from public.group_members m
      where m.group_thread_id = group_threads.id and m.user_id = auth.uid()
    )
  );

create policy group_members_select_fellow_member on public.group_members
  for select
  to authenticated
  using (
    exists (
      select 1 from public.group_members m
      where m.group_thread_id = group_members.group_thread_id and m.user_id = auth.uid()
    )
  );

create policy group_messages_select_member on public.group_messages
  for select
  to authenticated
  using (
    exists (
      select 1 from public.group_members m
      where m.group_thread_id = group_messages.group_thread_id and m.user_id = auth.uid()
    )
  );

-- Ledger reason/ref_type vocabulary, extended per credit_transfer's
-- precedent (drop + recreate the check constraint rather than a second
-- constraint, matching that migration's own approach).
alter table public.ledger_entries drop constraint ledger_entries_reason_check;
alter table public.ledger_entries add constraint ledger_entries_reason_check check (reason in (
  'topup_purchase',
  'topup_platform_fee',
  'message_debit',
  'escrow_hold',
  'escrow_release_earning',
  'escrow_release_platform_cut',
  'escrow_refund_unanswered',
  'earnings_conversion',
  'withdrawal_platform_fee',
  'withdrawal_payout',
  'withdrawal_refund_failed',
  'status_upload_debit',
  'manual_adjustment',
  'credit_transfer_sent',
  'credit_transfer_received',
  'credit_transfer_conversion',
  'credit_transfer_platform_cut',
  'group_message_debit',
  'group_message_owner_earning',
  'group_message_platform_cut'
));

alter table public.ledger_entries drop constraint ledger_entries_ref_type_check;
alter table public.ledger_entries add constraint ledger_entries_ref_type_check
  check (ref_type in ('message', 'topup', 'withdrawal', 'escrow', 'status_update', 'credit_transfer', 'group_message'));

insert into public.pricing_config (key, value, description) values
  -- The actual kill switch for docs/03 §10's gating decision: 0 until
  -- Phase 5's fraud infra exists, per docs/08's Phase 5 exit-criteria
  -- bullet. fn_send_group_message checks this itself (not just the Edge
  -- Function), so there's no path to bypass it by calling the DB function
  -- directly.
  ('group_chat_enabled', 0, 'Kill switch for group-chat billing (docs/03-ECONOMY-LEDGER.md §10) — 0 (disabled) until Phase 5 fraud infra exists; 1 to enable'),
  ('platform_group_message_take_bps', 3000, 'Platform cut on a group message''s cost, in basis points (3000 = 30.00%) — remainder goes to the group owner; independently tunable from platform_earning_take_bps/platform_transfer_take_bps');

-- =============================================================================
-- fn_send_group_message — the group-chat analog of fn_send_message. Any
-- member can post; the sender always pays the normal word-count cost.
-- Unlike fn_send_message, there is no escrow/release step — the 70/30
-- split (or 0/0 on a self-post) settles in the same call.
-- =============================================================================

create function public.fn_send_group_message(
  p_group_thread_id uuid,
  p_sender_id uuid,
  p_body text
)
returns table (
  message_id uuid,
  credits_charged bigint,
  word_count integer,
  owner_earning_credits bigint,
  platform_take_credits bigint,
  payer_balance_after bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled bigint;
  v_group public.group_threads%rowtype;
  v_is_owner_post boolean;
  v_word_count integer;
  v_block_size bigint;
  v_base_credits bigint;
  v_max_words bigint;
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_credits bigint;
  v_owner_earning bigint := 0;
  v_platform_take bigint := 0;
  v_sender_wallet_id uuid;
  v_owner_earnings_wallet_id uuid;
  v_owner_cash_wallet_id uuid;
  v_platform_wallet_id uuid;
  v_wallet_ids uuid[];
  v_wallet_id uuid;
  v_sender_balance bigint;
  v_sender_frozen boolean;
  v_owner_earnings_frozen boolean;
  v_owner_cash_frozen boolean;
  v_message_id uuid;
begin
  select value into v_enabled from pricing_config where key = 'group_chat_enabled';
  if coalesce(v_enabled, 0) = 0 then
    raise exception 'group_chat_disabled';
  end if;

  select * into v_group from group_threads where id = p_group_thread_id for update;
  if not found then
    raise exception 'group_not_found';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_sender_id
  ) then
    raise exception 'not_a_member';
  end if;

  v_is_owner_post := (p_sender_id = v_group.created_by);

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 then
    raise exception 'empty_message';
  end if;

  -- Same config keys fn_send_message uses (docs/03 §10: "same word-count
  -- formula as §4", not a separate group pricing tier).
  select value into v_block_size from pricing_config where key = 'message_word_block_size';
  select value into v_base_credits from pricing_config where key = 'message_base_credits';
  select value into v_max_words from pricing_config where key = 'message_max_words';

  if v_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
  end if;

  v_credits := (v_base_credits * greatest(ceil(v_word_count::numeric / v_block_size), 1))::bigint;

  select id into v_sender_wallet_id from wallets
    where user_id = p_sender_id and kind = 'topup_credit';

  if not v_is_owner_post then
    select value into v_take_bps from pricing_config where key = 'platform_group_message_take_bps';
    select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

    select id into v_owner_earnings_wallet_id from wallets
      where user_id = v_group.created_by and kind = 'earnings_pending';
    select id into v_owner_cash_wallet_id from wallets
      where user_id = v_group.created_by and kind = 'withdrawable_cash';
    -- Same platform wallet fn_transfer_credit's cut already uses — a
    -- credit-denominated take, per that migration's own kobo/credit split
    -- rationale, not a new dedicated wallet kind for one more fee line.
    select id into v_platform_wallet_id from wallets
      where kind = 'platform_revenue_earnings_cut' and user_id is null;

    -- Fixed ascending-id lock order across every wallet this call might
    -- touch (docs/02-DATA-MODEL.md §3, same rule fn_transfer_credit
    -- follows) — necessary here because, like that function, this one
    -- locks a different user's (the owner's) wallets in the same call.
    v_wallet_ids := array(
      select unnest(array[
        v_sender_wallet_id, v_owner_earnings_wallet_id, v_owner_cash_wallet_id, v_platform_wallet_id
      ]) order by 1
    );
  else
    v_wallet_ids := array[v_sender_wallet_id];
  end if;

  foreach v_wallet_id in array v_wallet_ids loop
    perform 1 from wallets where id = v_wallet_id for update;
  end loop;

  select balance, is_frozen into v_sender_balance, v_sender_frozen
    from wallets where id = v_sender_wallet_id;

  if v_sender_frozen then
    raise exception 'wallet_frozen';
  end if;

  if not v_is_owner_post then
    select is_frozen into v_owner_earnings_frozen from wallets where id = v_owner_earnings_wallet_id;
    select is_frozen into v_owner_cash_frozen from wallets where id = v_owner_cash_wallet_id;
    if v_owner_earnings_frozen or v_owner_cash_frozen then
      raise exception 'wallet_frozen';
    end if;
  end if;

  if v_sender_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_sender_balance;
  end if;

  if not v_is_owner_post then
    v_platform_take := round(v_credits::numeric * v_take_bps / 10000)::bigint;
    v_owner_earning := v_credits - v_platform_take;
  end if;

  insert into group_messages (
    group_thread_id, sender_id, body, word_count, credits_charged,
    owner_earning_credits, platform_take_credits
  )
  values (
    p_group_thread_id, p_sender_id, p_body, v_word_count, v_credits,
    v_owner_earning, v_platform_take
  )
  returning id into v_message_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_sender_wallet_id, -v_credits, 'group_message_debit', 'group_message', v_message_id);

  if v_owner_earning > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_owner_earnings_wallet_id, v_owner_earning, 'group_message_owner_earning', 'group_message', v_message_id);

    -- Immediate auto-conversion to cash, same two-step shape
    -- fn_release_escrow/fn_transfer_credit already use.
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_owner_earnings_wallet_id, -v_owner_earning, 'earnings_conversion', 'group_message', v_message_id);

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_owner_cash_wallet_id, v_owner_earning * v_unit_kobo, 'earnings_conversion', 'group_message', v_message_id);
  end if;

  if v_platform_take > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_platform_wallet_id, v_platform_take, 'group_message_platform_cut', 'group_message', v_message_id);
  end if;

  update group_threads set last_message_at = now() where id = p_group_thread_id;

  select balance into v_sender_balance from wallets where id = v_sender_wallet_id;

  return query select
    v_message_id, v_credits, v_word_count, v_owner_earning, v_platform_take, v_sender_balance;
end;
$$;

revoke execute on function public.fn_send_group_message(uuid, uuid, text) from public;
grant execute on function public.fn_send_group_message(uuid, uuid, text) to service_role;
