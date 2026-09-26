-- Payer/Earner role (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §C1,
-- built after two review passes — the first caught that the literal brief's
-- "pending consent, decide on reply" mechanic breaks the atomic-debit
-- invariant; the second caught that "same fn_release_escrow flow, no
-- changes" was itself false. Both are addressed below, not deferred.
--
-- The model: `threads.payer_id` is a new, separate, mutable ECONOMIC role
-- layered on top of the existing, permanent, structural
-- `participant_a`/`participant_b` pair. Nothing that means "the two people
-- in this thread" (membership checks, blocking, the free-status-reply
-- "who's the other participant" lookup) changes — only the two places that
-- specifically meant "who pays"/"who earns" move to the new role.

alter table public.threads add column payer_id uuid references public.users (id);

-- Backfill: every thread that predates this feature keeps today's exact
-- behavior (participant_a pays, forever) until someone touches the role.
update public.threads set payer_id = participant_a where payer_id is null;

-- fn_start_thread must also set payer_id on every NEW thread going
-- forward — a plain column default can't reference another column of the
-- same row being inserted, so this has to be done in the function, not the
-- schema. Every other line is unchanged from the live definition
-- (20260912072753_security_definer_functions.sql).
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
  where participant_a = p_payer_id and participant_b = p_payee_id;

  if not found then
    insert into threads (participant_a, participant_b, payer_id)
    values (p_payer_id, p_payee_id, p_payer_id)
    returning id into v_thread_id;
  end if;

  return v_thread_id;
end;
$$;

-- =============================================================================
-- thread_payer_history — append-only audit trail, same posture
-- pricing_config_history/admin_audit_log already establish for anything
-- money-adjacent. Not load-bearing for the mechanism; cheap and the right
-- level of rigor for a feature that changes who pays.
-- =============================================================================

create table public.thread_payer_history (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.threads (id),
  changed_by uuid not null references public.users (id),
  old_payer_id uuid references public.users (id),
  new_payer_id uuid references public.users (id),
  changed_at timestamptz not null default now()
);

create index thread_payer_history_thread_id_idx on public.thread_payer_history (thread_id);

alter table public.thread_payer_history enable row level security;

-- Same shape as escrows_select_participant: visible to either participant
-- of the thread, no direct client insert/update/delete policy — the only
-- writer is fn_set_thread_payer below, which as a SECURITY DEFINER
-- function bypasses RLS on its own inserts.
create policy thread_payer_history_select_participant on public.thread_payer_history
  for select
  to authenticated
  using (
    exists (
      select 1 from public.threads t
      where t.id = thread_payer_history.thread_id
        and (t.participant_a = auth.uid() or t.participant_b = auth.uid())
    )
  );

-- =============================================================================
-- pricing_config: idle-conversation gate on taking over the payer role.
-- Chosen over a flat "cooldown since last reassignment" timer specifically
-- because a timer can be waited out while messaging continues normally; an
-- idle-conversation requirement can't, since the collusion pattern this
-- guards against (docs/06) only has value at real message volume, which is
-- exactly what keeps a thread's last_message_at fresh and the gate closed.
-- =============================================================================

insert into public.pricing_config (key, currency, value, description) values
  ('thread_payer_min_idle_hours', 'NGN', 24,
   'How long a thread must have had no message from either participant before the payer role can be taken over (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §C1) — gates fn_set_thread_payer''s self-claim path, not stepping down (which is always instant, since it cannot be monetized). Applies to claiming out of a null payer_id too, not only taking over an active payer, so "step down then immediately re-claim" cannot be used to route around the gate.')
on conflict (key, currency) do nothing;

-- =============================================================================
-- fn_set_thread_payer — the only write path for threads.payer_id.
--
-- Self-only, enforced here rather than trusted from the client: a caller
-- may only ever set payer_id to their own id or to null, never to the
-- other participant's id — nobody can be made to pay against their will.
--
-- Stepping down (p_new_payer_id = null) is instant and ungated, and only
-- the CURRENT payer may do it. Claiming (p_new_payer_id = caller's own id)
-- when the caller is not already the current payer is gated on the idle
-- check above, whether taking over from the other participant's active
-- role or claiming out of null — see the pricing_config row's own
-- rationale for why null is not exempted.
--
-- Opens with `select ... for update` on the thread row, the same lock
-- fn_send_message already takes for exactly this reason: a concurrent send
-- and a concurrent role-change must serialize, not interleave and read a
-- stale payer_id/last_message_at. No new locking primitive, just the
-- existing pattern applied to a new writer of that row.
-- =============================================================================

create function public.fn_set_thread_payer(p_thread_id uuid, p_caller_id uuid, p_new_payer_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_min_idle_hours bigint;
begin
  select * into v_thread from threads where id = p_thread_id for update;
  if not found then
    raise exception 'thread_not_found';
  end if;

  if p_caller_id not in (v_thread.participant_a, v_thread.participant_b) then
    raise exception 'not_a_participant';
  end if;

  if p_new_payer_id is not null and p_new_payer_id <> p_caller_id then
    raise exception 'can_only_appoint_self';
  end if;

  if p_new_payer_id is null then
    -- Stepping down: only the current payer may do this, any time.
    if v_thread.payer_id is distinct from p_caller_id then
      raise exception 'not_current_payer';
    end if;
  elsif v_thread.payer_id = p_caller_id then
    -- Already the payer — idempotent no-op, not an error.
    return;
  else
    -- Taking over (from the other participant's active role, or out of
    -- null) — gated on conversation idle time.
    select value into v_min_idle_hours
      from pricing_config where key = 'thread_payer_min_idle_hours' and currency = 'NGN';

    if v_thread.last_message_at is not null
      and v_thread.last_message_at > now() - make_interval(hours => v_min_idle_hours::integer)
    then
      raise exception 'thread_not_idle_long_enough';
    end if;
  end if;

  insert into thread_payer_history (thread_id, changed_by, old_payer_id, new_payer_id)
  values (p_thread_id, p_caller_id, v_thread.payer_id, p_new_payer_id);

  update threads set payer_id = p_new_payer_id where id = p_thread_id;
end;
$$;

revoke execute on function public.fn_set_thread_payer(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_set_thread_payer(uuid, uuid, uuid) to service_role;

-- =============================================================================
-- fn_release_escrow — corrected to be payee-agnostic. The live version
-- (20260915150000_platform_reserve_buffer.sql) hardcodes v_thread.
-- participant_b as "the payee" in three places: the earnings/withdrawable
-- wallet lookups, the hourly earnings-release rate cap, and the release-
-- time duplicate-content check. Safe only because participant_b genuinely
-- is the payee of every escrow in every thread today — an assumption C1
-- breaks the moment a payer role has ever flipped, since escrows in the
-- same thread can then carry different frozen payee_id values.
--
-- Fix: take the sender as an explicit new parameter, and filter the
-- release loop to `payee_id = p_sender_id`. Every escrow this call
-- actually processes is then guaranteed to share the same payee (the
-- sender), so every other lookup below can stay a once-per-call read,
-- exactly as before, just keyed off the parameter instead of a hardcoded
-- column. fn_send_message's old `v_is_reply` pre-check (itself another
-- hardcoded-participant_b spot) is deleted, not repaired — this function
-- is now called unconditionally on every send and is a harmless no-op
-- when the sender isn't owed on anything pending.
--
-- fn_refund_expired_escrows is untouched: it already resolves the payer
-- wallet from each escrow's own payer_id, not from thread.participant_a,
-- and was already correct. Collusion detection
-- (20260915093000_collusion_detection.sql) is untouched for the same
-- reason — already keyed off escrows.payer_id/payee_id symmetrically.
-- =============================================================================

drop function public.fn_release_escrow(uuid);

create function public.fn_release_escrow(p_thread_id uuid, p_sender_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_earnings_pending_wallet_id uuid;
  v_earnings_pending_frozen boolean;
  v_withdrawable_cash_wallet_id uuid;
  v_withdrawable_cash_frozen boolean;
  v_escrow record;
  v_platform_cut bigint;
  v_payee_amount bigint;
  v_released_count integer := 0;
  v_per_minute_cap bigint;
  v_per_hour_cap bigint;
  v_similarity_threshold_bps bigint;
  v_lookback_n bigint;
  v_thread_release_count_1m bigint;
  v_payee_release_count_1h bigint;
  v_message_body text;
  v_message_sender_id uuid;
  v_recent_body text;
  v_is_duplicate boolean;
begin
  select * into v_thread from threads where id = p_thread_id;
  if not found then
    raise exception 'thread_not_found';
  end if;

  select value into v_take_bps from pricing_config where key = 'platform_earning_take_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';
  select value into v_per_minute_cap from pricing_config where key = 'escrow_release_messages_per_minute_cap';
  select value into v_per_hour_cap from pricing_config where key = 'escrow_release_earnings_per_hour_cap';
  select value into v_similarity_threshold_bps from pricing_config where key = 'duplicate_content_similarity_threshold_bps';
  select value into v_lookback_n from pricing_config where key = 'duplicate_content_lookback_messages';

  select id, is_frozen into v_earnings_pending_wallet_id, v_earnings_pending_frozen from wallets
    where user_id = p_sender_id and kind = 'earnings_pending'
    for update;

  select id, is_frozen into v_withdrawable_cash_wallet_id, v_withdrawable_cash_frozen from wallets
    where user_id = p_sender_id and kind = 'withdrawable_cash'
    for update;

  if v_earnings_pending_frozen or v_withdrawable_cash_frozen then
    raise exception 'wallet_frozen';
  end if;

  select count(*) into v_thread_release_count_1m from escrows
    where thread_id = p_thread_id and status = 'released' and created_at > now() - interval '1 minute';

  select count(*) into v_payee_release_count_1h from escrows
    where payee_id = p_sender_id and status = 'released' and created_at > now() - interval '1 hour';

  for v_escrow in
    select * from escrows
    where thread_id = p_thread_id and payee_id = p_sender_id and status = 'pending'
    order by created_at
    for update
  loop
    if v_thread_release_count_1m >= v_per_minute_cap or v_payee_release_count_1h >= v_per_hour_cap then
      continue;
    end if;

    select body, sender_id into v_message_body, v_message_sender_id
      from messages where id = v_escrow.message_id;

    v_is_duplicate := false;
    for v_recent_body in
      select body from messages
      where sender_id = p_sender_id and id <> v_escrow.message_id
      order by created_at desc
      limit v_lookback_n
    loop
      if similarity(v_message_body, v_recent_body) >= (v_similarity_threshold_bps::numeric / 10000) then
        v_is_duplicate := true;
        exit;
      end if;
    end loop;

    if v_is_duplicate then
      if not exists (
        select 1 from fraud_signals
        where user_id = p_sender_id
          and signal_type = 'duplicate_content'
          and created_at > now() - interval '1 hour'
      ) then
        insert into fraud_signals (user_id, signal_type, severity, metadata)
        values (
          p_sender_id, 'duplicate_content', 'medium',
          jsonb_build_object('thread_id', p_thread_id, 'message_id', v_escrow.message_id)
        );
      end if;
      continue;
    end if;

    v_platform_cut := round(v_escrow.credits_held::numeric * v_take_bps / 10000)::bigint;
    v_payee_amount := v_escrow.credits_held - v_platform_cut;

    if v_payee_amount > 0 then
      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_earnings_pending_wallet_id, v_payee_amount, 'escrow_release_earning', 'escrow', v_escrow.id);

      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_earnings_pending_wallet_id, -v_payee_amount, 'earnings_conversion', 'escrow', v_escrow.id);

      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_withdrawable_cash_wallet_id, v_payee_amount * v_unit_kobo, 'earnings_conversion', 'escrow', v_escrow.id);
    end if;

    perform fn_credit_platform_revenue(
      'platform_revenue_earnings_cut', 'platform_reserve_earnings_cut',
      v_platform_cut, 'escrow_release_platform_cut', 'escrow', v_escrow.id
    );

    update escrows set status = 'released' where id = v_escrow.id;
    update messages set status = 'released' where id = v_escrow.message_id;

    v_released_count := v_released_count + 1;
    v_thread_release_count_1m := v_thread_release_count_1m + 1;
    v_payee_release_count_1h := v_payee_release_count_1h + 1;
  end loop;

  return v_released_count;
end;
$$;

revoke execute on function public.fn_release_escrow(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_release_escrow(uuid, uuid) to service_role;

-- =============================================================================
-- fn_send_message — dropped and recreated. Every line outside the payer/
-- payee resolution is unchanged from the live definition
-- (20260926130000_free_status_reply_first_message.sql), confirmed via
-- pg_get_functiondef immediately before writing this migration. Real
-- changes:
--
--   1. The payer-side balance/currency lookup and the escrow insert move
--      from v_thread.participant_a/participant_b to v_thread.payer_id and
--      its computed counterpart (v_payee_id) — a thread with
--      payer_id is null raises no_active_payer before anything else runs.
--   2. v_is_reply is deleted. fn_release_escrow is now called
--      unconditionally with p_sender_id — see that function's own header
--      comment for why this is a correction, not just a simplification.
--   3. Every other line — media validation, status-reply free-eligibility,
--      pricing-strategy lookup, idempotency-by-client_message_id — is
--      untouched, because none of it means "who pays"; it means "who are
--      the two people in this thread" (participant_a/participant_b,
--      correctly left alone) or is payer-role-independent already.
-- =============================================================================

drop function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid);

create function public.fn_send_message(
  p_thread_id uuid,
  p_sender_id uuid,
  p_body text,
  p_client_message_id uuid default null,
  p_reply_to_message_id uuid default null,
  p_is_forwarded boolean default false,
  p_media_path text default null,
  p_media_type text default null,
  p_duration_seconds integer default null,
  p_waveform_samples smallint[] default null,
  p_reply_to_status_id uuid default null
)
returns table(message_id uuid, credits_charged bigint, word_count integer, status text, payer_balance_after bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_payee_id uuid;
  v_word_count integer;
  v_max_words bigint;
  v_credits bigint;
  v_media_credits bigint;
  v_has_media boolean;
  v_max_audio_seconds bigint;
  v_sample smallint;
  v_refund_hours bigint;
  v_payer_wallet_id uuid;
  v_payer_balance bigint;
  v_payer_frozen boolean;
  v_payer_currency text;
  v_active_strategy text;
  v_message_id uuid;
  v_existing record;
  v_status_poster_id uuid;
  v_is_free_status_reply boolean;
  v_message_status text;
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
        where user_id = v_thread.payer_id and kind = 'topup_credit';

      return query select v_existing.id, v_existing.credits_charged, v_existing.word_count,
        v_existing.status, v_payer_balance;
      return;
    end if;
  end if;

  if v_thread.blocked_by is not null then
    raise exception 'thread_blocked';
  end if;

  if v_thread.payer_id is null then
    raise exception 'no_active_payer';
  end if;

  v_payee_id := case
    when v_thread.payer_id = v_thread.participant_a then v_thread.participant_b
    else v_thread.participant_a
  end;

  if p_reply_to_message_id is not null then
    if not exists (
      select 1 from messages where id = p_reply_to_message_id and thread_id = p_thread_id
    ) then
      raise exception 'invalid_reply_target';
    end if;
  end if;

  -- docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1 — validated up
  -- front, unconditionally, before we know whether it'll be free. This is
  -- "the other participant in this thread," a structural fact independent
  -- of who currently pays, so it deliberately still reads
  -- participant_a/participant_b, not payer_id/v_payee_id.
  v_status_poster_id := case
    when p_sender_id = v_thread.participant_a then v_thread.participant_b
    else v_thread.participant_a
  end;
  if p_reply_to_status_id is not null then
    if not exists (
      select 1 from status_updates
      where id = p_reply_to_status_id
        and user_id = v_status_poster_id
        and expires_at > now()
    ) then
      raise exception 'invalid_status_reply_target';
    end if;
  end if;

  v_has_media := p_media_path is not null and length(trim(both from p_media_path)) > 0;

  if v_has_media then
    if p_media_path not like (p_sender_id::text || '/%') then
      raise exception 'invalid_media_path';
    end if;
    if p_media_type is null or p_media_type not in ('image', 'audio') then
      raise exception 'unsupported_media_type';
    end if;
    -- The path-ownership check above only proves the path was *minted*
    -- for this sender — it says nothing about whether the client's own
    -- upload to it actually succeeded before calling this. Charging for,
    -- and creating, a message with nothing behind it would be a real
    -- correctness bug (a permanently broken image or unplayable audio),
    -- worth one extra existence check on what is otherwise a rare,
    -- defensive path.
    if not exists (
      select 1 from storage.objects where bucket_id = 'chat-media' and name = p_media_path
    ) then
      raise exception 'media_not_found';
    end if;

    if p_media_type = 'audio' then
      if p_duration_seconds is null or p_duration_seconds < 0 then
        raise exception 'invalid_duration';
      end if;

      select value into v_max_audio_seconds
        from pricing_config where key = 'message_audio_max_seconds' and currency = (
          select currency from wallets where user_id = v_thread.payer_id and kind = 'topup_credit'
        );
      if v_max_audio_seconds is null then
        raise exception 'pricing_config_not_found_for_currency: message_audio_max_seconds';
      end if;
      if p_duration_seconds > v_max_audio_seconds then
        raise exception 'audio_too_long: % seconds exceeds max of %', p_duration_seconds, v_max_audio_seconds;
      end if;

      if p_waveform_samples is not null then
        foreach v_sample in array p_waveform_samples loop
          if v_sample < 0 or v_sample > 100 then
            raise exception 'invalid_waveform_samples';
          end if;
        end loop;
      end if;
    end if;
  end if;

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 and not v_has_media then
    raise exception 'empty_message';
  end if;

  select id, balance, is_frozen, currency into v_payer_wallet_id, v_payer_balance, v_payer_frozen, v_payer_currency
  from wallets
  where user_id = v_thread.payer_id and kind = 'topup_credit'
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

  -- docs/18 §B1 — free only for the sender's genuinely first message in
  -- this thread, evaluated before this message's own insert, and only
  -- when it carries no media (media keeps its own separate billing).
  v_is_free_status_reply :=
    p_reply_to_status_id is not null
    and not v_has_media
    and not exists (select 1 from messages where thread_id = p_thread_id and sender_id = p_sender_id);

  if v_is_free_status_reply then
    v_credits := 0;
    v_message_status := 'sent';
  else
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

    if v_has_media then
      if p_media_type = 'audio' then
        select value into v_media_credits from pricing_config where key = 'message_audio_credits' and currency = v_payer_currency;
        if v_media_credits is null then
          raise exception 'pricing_config_not_found_for_currency: message_audio_credits %', v_payer_currency;
        end if;
      else
        select value into v_media_credits from pricing_config where key = 'message_media_credits' and currency = v_payer_currency;
        if v_media_credits is null then
          raise exception 'pricing_config_not_found_for_currency: message_media_credits %', v_payer_currency;
        end if;
      end if;
      v_credits := v_credits + v_media_credits;
    end if;

    if v_payer_balance < v_credits then
      raise exception 'insufficient_credit: need % have %', v_credits, v_payer_balance;
    end if;

    v_message_status := 'escrowed';
  end if;

  insert into messages (
    thread_id, sender_id, body, word_count, credits_charged, status,
    client_message_id, reply_to_message_id, is_forwarded, media_path, media_type,
    duration_seconds, waveform_samples, reply_to_status_id
  )
  values (
    p_thread_id, p_sender_id, p_body, v_word_count, v_credits, v_message_status,
    p_client_message_id, p_reply_to_message_id, coalesce(p_is_forwarded, false),
    p_media_path, p_media_type,
    case when p_media_type = 'audio' then p_duration_seconds else null end,
    case when p_media_type = 'audio' then p_waveform_samples else null end,
    p_reply_to_status_id
  )
  returning id into v_message_id;

  if not v_is_free_status_reply then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_payer_wallet_id, -v_credits, 'message_debit', 'message', v_message_id);

    insert into escrows (thread_id, message_id, payer_id, payee_id, credits_held, status, expires_at)
    values (
      p_thread_id, v_message_id, v_thread.payer_id, v_payee_id,
      v_credits, 'pending', now() + make_interval(hours => v_refund_hours::integer)
    );
  end if;

  update threads set last_message_at = now() where id = p_thread_id;

  perform fn_release_escrow(p_thread_id, p_sender_id);

  select balance into v_payer_balance from wallets where id = v_payer_wallet_id;

  return query select v_message_id, v_credits, v_word_count, v_message_status, v_payer_balance;
end;
$$;

revoke execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid) from public, anon, authenticated;
grant execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid) to service_role;
