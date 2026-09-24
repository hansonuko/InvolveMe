-- Admin dashboard: pricing-strategy-switch framework
-- (docs/14-ADMIN-DASHBOARD-SCOPING.md §4.3, "Introduce new features not
-- yet set"). Piece 1 — schema, the three pluggable pricing functions, and
-- fn_send_message's dispatch. UI is piece 2.
--
-- Three real findings from the pre-build review shaped this migration:
--
--   1. §4.3's literal proposal (`pricing_config.active_pricing_strategy`
--      as a new pricing_config key) doesn't fit the schema —
--      pricing_config.value is bigint-only by design (money/counts, never
--      text). A strategy NAME needs its own small table, not a
--      pricing_config row. message_pricing_strategy below is that table.
--
--   2. A real, pre-existing latent bug lives exactly where this migration
--      needed to extract from: confirmed directly against the live
--      fn_send_message that it read message_word_block_size/
--      message_base_credits/message_max_words from pricing_config with NO
--      currency filter at all — harmless today only because exactly one
--      currency (NGN) has rows for these keys (confirmed directly).
--      Since this migration extracts that exact logic into pluggable
--      functions anyway, threading currency through correctly is directly
--      in scope, not proactive over-engineering — leaving it ambiguous
--      would just relocate the bug into three new functions instead of
--      fixing it. escrow_unanswered_refund_hours' own (separately
--      ambiguous) read is deliberately left untouched — out of scope for
--      this change, a temporal parameter this function doesn't otherwise
--      touch here.
--
--   3. `flat_per_message` (one of §4.3's own named example strategies) is
--      structurally the same shape as the exploit CLAUDE.md rule #8 says
--      was already closed ("flat cost regardless of length" —
--      docs/06-SECURITY-FRAUD-LOOPHOLES.md §1). message_max_words (the
--      existing 500-word hard cap) stays a strategy-INDEPENDENT guard —
--      fn_send_message still enforces it before ever computing a price,
--      regardless of which strategy is active — so switching to
--      flat_per_message bounds the abuse (pay for 1 word what you'd
--      otherwise pay for 500) rather than reopening the original
--      UNBOUNDED exploit. Still a real, material weakening of the
--      anti-wash-chat economics docs/06 §1/§2 care about, not a routine
--      number tweak — so switching the active strategy is dual-approval-
--      gated unconditionally, same posture as every other first-ever-
--      built money-shape-changing capability this phase (platform_
--      withdrawal, manual_ledger_adjustment), not left as a simple toggle.
--
-- The three pricing functions are pure (STABLE, no writes) and dispatched
-- via a plain CASE on a fixed, hardcoded set of function names — never
-- dynamic SQL — matching §4.3's own explicit "must not become write
-- arbitrary billing logic from a text box" constraint. Genuinely new
-- strategies (a formula nobody has built yet) remain an engineering task;
-- this framework only makes switching among already-shipped, already-
-- tested strategies instant and reversible without a release.

-- =============================================================================
-- message_pricing_strategy — per-currency, seeded to exactly today's live
-- behavior so nothing changes until an admin deliberately switches it.
-- =============================================================================

create table public.message_pricing_strategy (
  currency text primary key,
  active_strategy text not null default 'tiered_word_block'
    check (active_strategy in ('tiered_word_block', 'flat_per_message', 'linear_per_word')),
  updated_at timestamptz not null default now(),
  updated_by_admin_id uuid references public.admin_users(id)
);

insert into public.message_pricing_strategy (currency, active_strategy) values ('NGN', 'tiered_word_block');

alter table public.message_pricing_strategy enable row level security;

revoke insert, update, delete on public.message_pricing_strategy from public, anon, authenticated, service_role;
grant select on public.message_pricing_strategy to service_role;

-- =============================================================================
-- New pricing_config keys the two new strategies read — seeded to
-- roughly match today's per-message cost, so a future switch doesn't
-- cause a surprise price jump on day one. Neither takes effect unless its
-- strategy is actually selected.
-- =============================================================================

insert into public.pricing_config (key, currency, value, description) values
  ('message_flat_credits', 'NGN', 2,
   'flat_per_message strategy: fixed credit cost per message regardless of length (still bounded by message_max_words) — only takes effect if the active strategy is switched to flat_per_message'),
  ('message_credits_per_100_words', 'NGN', 4,
   'linear_per_word strategy: credits charged per 100 words, rounded up, minimum 1 — only takes effect if the active strategy is switched to linear_per_word')
on conflict (key, currency) do nothing;

-- =============================================================================
-- New dual-approved action_type for switching the active strategy, and
-- the propose/approve engine's permission mapping extended to match.
-- =============================================================================

alter table public.admin_pending_actions drop constraint admin_pending_actions_action_type_check;
alter table public.admin_pending_actions add constraint admin_pending_actions_action_type_check
  check (action_type in (
    'pricing_config_update',
    'manual_ledger_adjustment',
    'platform_bank_account_registration',
    'platform_withdrawal',
    'message_pricing_strategy_change'
  ));

create or replace function public.fn_admin_pending_action_required_permission(p_action_type text)
returns text
language sql
immutable
as $$
  select case p_action_type
    when 'pricing_config_update' then 'edit_pricing_config'
    when 'manual_ledger_adjustment' then 'post_manual_adjustment'
    when 'platform_bank_account_registration' then 'manage_platform_bank_accounts'
    when 'platform_withdrawal' then 'initiate_platform_withdrawal'
    when 'message_pricing_strategy_change' then 'edit_pricing_config'
    else null
  end;
$$;

-- =============================================================================
-- fn_admin_set_message_pricing_strategy — the only sanctioned write path
-- to message_pricing_strategy. Redeems an approved
-- 'message_pricing_strategy_change' pending action and verifies the
-- consumed payload matches every argument.
-- =============================================================================

create function public.fn_admin_set_message_pricing_strategy(
  p_actor_admin_id uuid,
  p_pending_action_id uuid,
  p_currency text,
  p_active_strategy text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'edit_pricing_config') then
    raise exception 'not_authorized';
  end if;

  v_payload := public.fn_admin_consume_approved_pending_action(p_pending_action_id, 'message_pricing_strategy_change');

  if v_payload->>'currency' is distinct from p_currency
     or v_payload->>'active_strategy' is distinct from p_active_strategy
  then
    raise exception 'pending_action_payload_mismatch';
  end if;

  insert into public.message_pricing_strategy (currency, active_strategy, updated_at, updated_by_admin_id)
  values (p_currency, p_active_strategy, now(), p_actor_admin_id)
  on conflict (currency) do update
    set active_strategy = excluded.active_strategy, updated_at = now(), updated_by_admin_id = p_actor_admin_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'set_message_pricing_strategy',
    'message_pricing_strategy',
    p_currency,
    null,
    jsonb_build_object('active_strategy', p_active_strategy),
    null
  );
end;
$$;

revoke execute on function public.fn_admin_set_message_pricing_strategy(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.fn_admin_set_message_pricing_strategy(uuid, uuid, text, text) to service_role;

-- =============================================================================
-- The three pluggable pricing functions. Pure (STABLE, no writes), each
-- currency-scoped, each fails loudly (not silently) if its currency's
-- config rows don't exist yet — the same fail-closed posture every other
-- currency-scoped lookup this phase added already uses.
-- =============================================================================

create function public.fn_price_message_tiered_word_block(p_word_count integer, p_currency text)
returns bigint
language plpgsql
stable
as $$
declare
  v_block_size bigint;
  v_base_credits bigint;
begin
  select value into v_block_size from public.pricing_config where key = 'message_word_block_size' and currency = p_currency;
  select value into v_base_credits from public.pricing_config where key = 'message_base_credits' and currency = p_currency;

  if v_block_size is null or v_base_credits is null then
    raise exception 'pricing_config_not_found_for_currency: tiered_word_block %', p_currency;
  end if;

  return (v_base_credits * greatest(ceil(p_word_count::numeric / v_block_size), 1))::bigint;
end;
$$;

revoke execute on function public.fn_price_message_tiered_word_block(integer, text) from public, anon, authenticated;
grant execute on function public.fn_price_message_tiered_word_block(integer, text) to service_role;

create function public.fn_price_message_flat(p_word_count integer, p_currency text)
returns bigint
language plpgsql
stable
as $$
declare
  v_flat_credits bigint;
begin
  -- p_word_count is intentionally not used to vary the price — a flat
  -- strategy is a flat strategy by definition. Still bounded by
  -- fn_send_message's own strategy-independent message_max_words check
  -- (see this migration's header comment on why that guard staying
  -- strategy-independent is load-bearing here).
  select value into v_flat_credits from public.pricing_config where key = 'message_flat_credits' and currency = p_currency;

  if v_flat_credits is null then
    raise exception 'pricing_config_not_found_for_currency: flat_per_message %', p_currency;
  end if;

  return greatest(v_flat_credits, 1)::bigint;
end;
$$;

revoke execute on function public.fn_price_message_flat(integer, text) from public, anon, authenticated;
grant execute on function public.fn_price_message_flat(integer, text) to service_role;

create function public.fn_price_message_linear(p_word_count integer, p_currency text)
returns bigint
language plpgsql
stable
as $$
declare
  v_credits_per_100_words bigint;
begin
  select value into v_credits_per_100_words from public.pricing_config where key = 'message_credits_per_100_words' and currency = p_currency;

  if v_credits_per_100_words is null then
    raise exception 'pricing_config_not_found_for_currency: linear_per_word %', p_currency;
  end if;

  return greatest(ceil(p_word_count::numeric * v_credits_per_100_words / 100), 1)::bigint;
end;
$$;

revoke execute on function public.fn_price_message_linear(integer, text) from public, anon, authenticated;
grant execute on function public.fn_price_message_linear(integer, text) to service_role;

-- =============================================================================
-- fn_send_message — dropped and recreated. Every line outside the pricing
-- block is copied verbatim from the live definition (confirmed via
-- pg_get_functiondef immediately before writing this migration, not from
-- an older migration file that might have drifted). The only real changes:
--
--   1. The payer wallet (id, balance, is_frozen, currency) is now fetched
--      and locked BEFORE pricing is computed, not after — needed to know
--      which currency's strategy/config to price in. No concurrency
--      behavior changes: nothing depended on price being computed before
--      the wallet lock, the lock still happens exactly once, in the same
--      place relative to every other write in this function.
--   2. message_max_words is now read with an explicit currency filter
--      (finding #2 above).
--   3. The single inlined pricing-formula line is replaced with a lookup
--      of message_pricing_strategy's active_strategy for this currency
--      (raising if unconfigured — fail closed, not a silent default) and
--      a plain CASE dispatch to one of the three functions above.
-- =============================================================================

drop function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean);

create function public.fn_send_message(
  p_thread_id uuid,
  p_sender_id uuid,
  p_body text,
  p_client_message_id uuid default null,
  p_reply_to_message_id uuid default null,
  p_is_forwarded boolean default false
)
returns table(message_id uuid, credits_charged bigint, word_count integer, status text, payer_balance_after bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_is_reply boolean;
  v_word_count integer;
  v_max_words bigint;
  v_credits bigint;
  v_refund_hours bigint;
  v_payer_wallet_id uuid;
  v_payer_balance bigint;
  v_payer_frozen boolean;
  v_payer_currency text;
  v_active_strategy text;
  v_message_id uuid;
  v_existing record;
begin
  select * into v_thread from threads where id = p_thread_id for update;
  if not found then
    raise exception 'thread_not_found';
  end if;

  if p_sender_id not in (v_thread.participant_a, v_thread.participant_b) then
    raise exception 'not_a_participant';
  end if;

  if p_client_message_id is not null then
    select messages.id, messages.credits_charged, messages.word_count, messages.status
      into v_existing
      from messages
      where sender_id = p_sender_id and client_message_id = p_client_message_id;

    if found then
      select balance into v_payer_balance
        from wallets
        where user_id = v_thread.participant_a and kind = 'topup_credit';

      return query select v_existing.id, v_existing.credits_charged, v_existing.word_count,
        v_existing.status, v_payer_balance;
      return;
    end if;
  end if;

  if v_thread.blocked_by is not null then
    raise exception 'thread_blocked';
  end if;

  if p_reply_to_message_id is not null then
    if not exists (
      select 1 from messages where id = p_reply_to_message_id and thread_id = p_thread_id
    ) then
      raise exception 'invalid_reply_target';
    end if;
  end if;

  v_is_reply := (p_sender_id = v_thread.participant_b);

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 then
    raise exception 'empty_message';
  end if;

  select id, balance, is_frozen, currency into v_payer_wallet_id, v_payer_balance, v_payer_frozen, v_payer_currency
  from wallets
  where user_id = v_thread.participant_a and kind = 'topup_credit'
  for update;

  if v_payer_frozen then
    raise exception 'wallet_frozen';
  end if;

  select value into v_max_words from pricing_config where key = 'message_max_words' and currency = v_payer_currency;
  select value into v_refund_hours from pricing_config where key = 'escrow_unanswered_refund_hours';

  if v_max_words is null then
    raise exception 'pricing_config_not_found_for_currency: message_max_words %', v_payer_currency;
  end if;

  if v_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
  end if;

  select active_strategy into v_active_strategy from message_pricing_strategy where currency = v_payer_currency;
  if not found then
    raise exception 'message_pricing_strategy_not_configured_for_currency: %', v_payer_currency;
  end if;

  case v_active_strategy
    when 'tiered_word_block' then
      v_credits := fn_price_message_tiered_word_block(v_word_count, v_payer_currency);
    when 'flat_per_message' then
      v_credits := fn_price_message_flat(v_word_count, v_payer_currency);
    when 'linear_per_word' then
      v_credits := fn_price_message_linear(v_word_count, v_payer_currency);
    else
      raise exception 'unknown_pricing_strategy: %', v_active_strategy;
  end case;

  if v_payer_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_payer_balance;
  end if;

  insert into messages (
    thread_id, sender_id, body, word_count, credits_charged, status,
    client_message_id, reply_to_message_id, is_forwarded
  )
  values (
    p_thread_id, p_sender_id, p_body, v_word_count, v_credits, 'escrowed',
    p_client_message_id, p_reply_to_message_id, coalesce(p_is_forwarded, false)
  )
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

revoke execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean) to service_role;
