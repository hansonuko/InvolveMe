-- Voice notes (audio chat messages) — docs/17-VOICE-NOTES-SCOPING.md, built
-- per explicit user go-ahead following that scoping pass. Extends the chat
-- photo pipeline (20260925120000_chat_media_pipeline.sql) rather than
-- forking it: same chat-media bucket, same signed-upload-URL-only posture,
-- same fn_send_message trust boundary (path-ownership prefix check +
-- Storage-existence check before ever charging or inserting a row). The
-- only genuinely new pieces are (1) widening media_type from a hardcoded
-- 'image' to an allow-list, (2) three new nullable, audio-only columns,
-- and (3) a server-enforced max-duration cap, since flat pricing removes
-- the "underpay for length" exploit but not "impose unbounded storage
-- cost for a fixed charge" (docs/17 §4).

-- =============================================================================
-- messages: three new nullable columns, audio-only in practice (a photo
-- message leaves all three null, same as it already leaves the pre-
-- existing media_path/media_type null when there's no attachment at all).
--
-- duration_seconds is display-only, never read by billing logic (docs/17
-- §3/§5 — trusting a client-reported duration for pricing would reopen the
-- same "not a client-supplied value taken on faith" problem media_path's
-- own ownership check exists to close; flat pricing sidesteps it
-- entirely). It IS used for the max-duration cap below, but only as a
-- ceiling check, not a price input — over-reporting it only gets a
-- message rejected sooner, never charged less.
--
-- waveform_samples is real amplitude data sampled client-side during
-- recording (docs/17 §5), not decorative — bounded at the column level to
-- a fixed max cardinality; per-value range ([0,100]) is enforced inside
-- fn_send_message below, since a CHECK constraint can't run a subquery
-- over unnest() the way that per-element validation needs.
--
-- audio_played_at is a lightweight, decorative read-state signal (docs/17
-- §8) parallel to the existing message read-receipt system — no escrow/
-- billing relevance, set once by the recipient's own client.
-- =============================================================================

alter table public.messages add column duration_seconds integer;
alter table public.messages add column waveform_samples smallint[];
alter table public.messages add column audio_played_at timestamptz;

alter table public.messages add constraint messages_duration_seconds_check
  check (duration_seconds is null or duration_seconds >= 0);

alter table public.messages add constraint messages_waveform_samples_cardinality_check
  check (waveform_samples is null or cardinality(waveform_samples) <= 64);

-- =============================================================================
-- New pricing_config keys — never hardcoded (CLAUDE.md rule #9). Own key,
-- not a reuse of message_media_credits (docs/17 §3): a voice note is a
-- different average payload/perceived value than a photo, and product/ops
-- should be able to move the two independently. Seeded at the same
-- 4-credit surcharge as message_media_credits as a starting point, not a
-- consequential decision baked into code — both are ordinary pricing_config
-- rows, tunable without a migration. message_audio_max_seconds mirrors
-- message_max_words' role for text: a hard, server-enforced ceiling, not a
-- client-side-only UX convention.
-- =============================================================================

insert into public.pricing_config (key, currency, value, description) values
  ('message_audio_credits', 'NGN', 4,
   'Flat surcharge added to a message''s word-count-based cost when it carries a voice-note attachment (docs/17-VOICE-NOTES-SCOPING.md §3) — additive, own key from message_media_credits so photo/audio pricing can move independently.'),
  ('message_audio_max_seconds', 'NGN', 300,
   'Hard server-enforced ceiling on a single voice note''s recorded duration (docs/17-VOICE-NOTES-SCOPING.md §4) — bounds storage/bandwidth cost per message under flat pricing; the client-side recorder UI should stop recording at this cap, but this is the actual gate, not that.')
on conflict (key, currency) do nothing;

-- =============================================================================
-- Storage: widen chat-media's allowed_mime_types to accept expo-audio's
-- recorded output. expo-audio's HIGH_QUALITY preset records AAC-in-M4A on
-- both iOS and Android — the safe, cross-platform-verified choice (same
-- "pick the proven option over the aspirational one" call the photo
-- pipeline made for JPEG over WebP). Both `audio/m4a` (the extension-
-- derived MIME commonly reported client-side) and `audio/mp4` (the
-- container's more formal IANA type) are allowed defensively; docs/17 §2.6
-- flags confirming the exact string live, on a real device, before the
-- client pipeline ships — this is the best-available-without-a-device
-- choice, not assumed infallible.
-- =============================================================================

update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'audio/m4a', 'audio/mp4']
where id = 'chat-media';

-- =============================================================================
-- fn_send_message — dropped and recreated. Every line outside the audio
-- block is unchanged from the live definition
-- (20260925120000_chat_media_pipeline.sql), confirmed via
-- pg_get_functiondef immediately before writing this migration. Real
-- changes:
--
--   1. Two new trailing default-valued params, p_duration_seconds/
--      p_waveform_samples — trailing, so every existing caller (send-
--      message Edge Function, any test) keeps working unchanged.
--   2. p_media_type's allow-list widens from exactly 'image' to
--      ('image', 'audio') — `is null or ... not in (...)` rather than a
--      bare `not in`, since `NULL not in (...)` evaluates to NULL (not
--      true) in SQL and a plpgsql `if NULL then` is treated as false,
--      which would have silently let a NULL media_type slip through
--      whenever media_path was set.
--   3. When p_media_type = 'audio': p_duration_seconds is required and
--      checked against message_audio_max_seconds (server-enforced, not
--      just client UX — docs/17 §4); p_waveform_samples, when present,
--      has every element bounds-checked to [0, 100] (the column CHECK
--      only bounds array length, not per-value range).
--   4. message_audio_credits added on top of the strategy-computed price
--      for an audio message, exactly parallel to how message_media_credits
--      already applies for a photo — mutually exclusive (a message can
--      carry one attachment or none, never both), so this is an
--      if/elsif alongside the existing image branch, not stacked with it.
--   5. duration_seconds/waveform_samples/audio_played_at (left null at
--      send time — only ever set by the recipient's client on first
--      playback) inserted into the new messages row.
-- =============================================================================

drop function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text);

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
  p_waveform_samples smallint[] default null
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

  insert into messages (
    thread_id, sender_id, body, word_count, credits_charged, status,
    client_message_id, reply_to_message_id, is_forwarded, media_path, media_type,
    duration_seconds, waveform_samples
  )
  values (
    p_thread_id, p_sender_id, p_body, v_word_count, v_credits, 'escrowed',
    p_client_message_id, p_reply_to_message_id, coalesce(p_is_forwarded, false),
    p_media_path, p_media_type,
    case when p_media_type = 'audio' then p_duration_seconds else null end,
    case when p_media_type = 'audio' then p_waveform_samples else null end
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

revoke execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[]) from public, anon, authenticated;
grant execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[]) to service_role;

-- =============================================================================
-- fn_delete_message_for_everyone — signature/return type unchanged (still
-- returns the cleared media_path, text), so this is create-or-replace, not
-- drop+create. Real change: now also blanks duration_seconds/
-- waveform_samples/audio_played_at — the existing body already blanked
-- media_path/media_type unconditionally (not type-specific), but those
-- three new audio-only columns didn't exist when that UPDATE was written
-- and would otherwise survive a delete-for-everyone on a voice note,
-- leaving a tombstoned message with orphaned audio metadata still attached.
-- =============================================================================

create or replace function public.fn_delete_message_for_everyone(p_message_id uuid, p_sender_id uuid)
returns text
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
  set body = '', deleted_for_everyone = true, media_path = null, media_type = null,
      duration_seconds = null, waveform_samples = null, audio_played_at = null
  where id = p_message_id;

  return v_message.media_path;
end;
$$;

revoke execute on function public.fn_delete_message_for_everyone(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_delete_message_for_everyone(uuid, uuid) to service_role;

-- =============================================================================
-- fn_mark_audio_played — the one new, small function this pipeline needs
-- beyond extending fn_send_message: sets audio_played_at the first time
-- the recipient's own client actually starts playback (docs/17 §8). Not
-- folded into any existing read-receipt function — read receipts are a
-- thread-wide "read up to here" cursor; this is a per-message, audio-only
-- flag with no relationship to that cursor. Idempotent (only the first
-- call sets it; later calls are a harmless no-op) and callable only by the
-- message's recipient, never the sender, on their own thread.
-- =============================================================================

create function public.fn_mark_audio_played(p_message_id uuid, p_listener_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
  v_thread threads%rowtype;
begin
  select * into v_message from messages where id = p_message_id;
  if not found then
    raise exception 'message_not_found';
  end if;

  if v_message.media_type is distinct from 'audio' then
    raise exception 'not_an_audio_message';
  end if;

  if v_message.sender_id = p_listener_id then
    raise exception 'cannot_mark_own_message_played';
  end if;

  select * into v_thread from threads where id = v_message.thread_id;
  if p_listener_id not in (v_thread.participant_a, v_thread.participant_b) then
    raise exception 'not_a_participant';
  end if;

  update messages set audio_played_at = now()
  where id = p_message_id and audio_played_at is null;
end;
$$;

revoke execute on function public.fn_mark_audio_played(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_mark_audio_played(uuid, uuid) to service_role;
