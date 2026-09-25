-- Free status replies — docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md
-- Tier B1, built per explicit user go-ahead scoped exactly as that doc
-- recommended: free applies only to the sender's first-ever message in a
-- thread, when it's a real reply to a real, unexpired, visible status,
-- and carries no media. Every message after that, from anyone, is billed
-- normally — this is not a general "status replies are free" switch.
--
-- Why "first message in the thread," not "first reply to this status":
-- replying to your own throwaway status (or a colluding account's) over
-- and over would otherwise be a repeatable free-messaging backdoor. Once
-- a thread has one message from a sender, every later message — status-
-- reply or not — goes through the normal word-count/media billing this
-- function already enforces. Why "no media": media has its own separate
-- surcharge economics (message_media_credits/message_audio_credits);
-- free-status-reply is scoped to text only so it can't be used to attach
-- an otherwise-billed photo/voice note for free.
--
-- A free message never creates an escrow (nothing was collected, so
-- there's nothing to hold/release/refund) — it lands with a new
-- `status = 'sent'` value instead of 'escrowed', settling immediately.
-- The poster earns nothing from this specific message, same as a status
-- "like" would — see this migration's own reasoning in docs/18 §B1 for
-- why that's the ledger-conservation-safe reading, not an oversight.

alter table public.messages add column reply_to_status_id uuid references public.status_updates (id);

alter table public.messages drop constraint messages_status_check;
alter table public.messages add constraint messages_status_check
  check (status in ('escrowed', 'released', 'refunded', 'sent'));

-- messages_credits_charged_check was `credits_charged > 0` — every message
-- before this one genuinely cost something. A free status-reply is the
-- first real `credits_charged = 0` row this table will ever hold; caught
-- live against the actual constraint (pg_get_constraintdef), not assumed,
-- same discipline the chat-media migration's word_count relaxation used
-- for the same reason (a captionless photo genuinely has 0 words).
alter table public.messages drop constraint messages_credits_charged_check;
alter table public.messages add constraint messages_credits_charged_check
  check (credits_charged >= 0);

-- =============================================================================
-- fn_send_message — dropped and recreated. Every line outside the status-
-- reply block is unchanged from the live definition
-- (20260926110000_chat_audio_messages_pipeline.sql), confirmed via
-- pg_get_functiondef immediately before writing this migration. Real
-- changes:
--
--   1. One new trailing default-valued param, p_reply_to_status_id.
--   2. When provided, it's ALWAYS validated (regardless of whether this
--      turns out to be a free send) — must reference a real status
--      belonging to the thread's other participant, unexpired — the
--      exact predicate status_updates_select_visible_to_thread_partner
--      already encodes, re-derived here for the same "RLS can't
--      reference another table's policy from inside a SECURITY DEFINER
--      function" reason every other cross-table check in this codebase
--      already repeats it for. A fabricated/expired/wrong-poster status
--      id is rejected outright, never silently ignored — this is what
--      stops a client from claiming "this is a status reply" for a
--      status that was never actually visible to them.
--   3. Free eligibility (v_is_free_status_reply) additionally requires
--      no media attached AND this being the sender's genuinely first
--      message ever in this thread — checked via a plain not-exists
--      against `messages`, evaluated before this message's own insert.
--   4. When free: v_credits forced to 0, the balance check and the
--      escrow/ledger inserts are skipped entirely, and the row's status
--      is 'sent' instead of 'escrowed'. message_max_words still applies
--      (checked before this branch, unconditionally) — free never means
--      unbounded.
--   5. reply_to_status_id is stored on the row whenever a valid target
--      was given, whether or not the send turned out to be free — so a
--      second, billed reply to someone's status still shows the "replied
--      to your status" context client-side.
-- =============================================================================

drop function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[]);

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
  v_is_reply boolean;
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

  -- docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1 — validated up
  -- front, unconditionally, before we know whether it'll be free.
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
          select currency from wallets where user_id = v_thread.participant_a and kind = 'topup_credit'
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

  v_is_reply := (p_sender_id = v_thread.participant_b);

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 and not v_has_media then
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
      p_thread_id, v_message_id, v_thread.participant_a, v_thread.participant_b,
      v_credits, 'pending', now() + make_interval(hours => v_refund_hours::integer)
    );
  end if;

  update threads set last_message_at = now() where id = p_thread_id;

  if v_is_reply then
    perform fn_release_escrow(p_thread_id);
  end if;

  select balance into v_payer_balance from wallets where id = v_payer_wallet_id;

  return query select v_message_id, v_credits, v_word_count, v_message_status, v_payer_balance;
end;
$$;

revoke execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid) from public, anon, authenticated;
grant execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid) to service_role;
