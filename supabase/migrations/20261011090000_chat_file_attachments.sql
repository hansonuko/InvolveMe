-- Generic file/document chat attachments (PDF, Office docs, zip, text,
-- etc.) — docs/16-CHAT-MEDIA-SCOPING.md §2 explicitly called this out as
-- "out of v1 scope... its own scoping pass if wanted" when photo
-- attachments shipped; voice notes got that follow-up pass later
-- (docs/17-VOICE-NOTES-SCOPING.md), this is the equivalent for files,
-- built per explicit user go-ahead. Mirrors the existing photo/audio
-- pipeline's shape everywhere it applies — new media_type value, same
-- private-bucket/signed-upload-URL/path-ownership-check machinery, same
-- flat-surcharge-on-top-of-the-word-count-formula billing model
-- (CLAUDE.md rules #1/#9) — not a new, parallel system.
--
-- One real difference from image/audio: those two have exactly one valid
-- file extension each (create-chat-media-upload-url picks it), so there
-- was never a need to remember what the user actually picked. A document
-- can be .pdf, .docx, .zip, .txt, and so on — the recipient needs to see
-- and save it under something resembling its real name, not a bare UUID.
-- `media_filename` is purely cosmetic/display (never used to construct
-- the real Storage path, which stays server-derived exactly as before),
-- so it only needs sanity bounds, not the strict trust boundary
-- media_path itself already has.
--
-- Moderation: deliberately unmoderated at launch, same documented
-- "flag it, don't silently skip it" posture docs/16 §5 already states for
-- images — OpenAI's omni-moderation model has no meaningful API for
-- arbitrary document/zip bytes the way it does for images, so this isn't
-- "the same gap as images," it's a different, currently-unaddressed
-- content-safety question worth a real decision before general
-- availability, not assumed solved here.
alter table public.messages add column media_filename text;

-- =============================================================================
-- New pricing_config key — never hardcoded (CLAUDE.md rule #9). Set at 2
-- credits per the explicit product decision on record (lower than the
-- existing 4-credit photo/audio surcharge — a deliberate choice, not an
-- oversight), subject to the usual pricing_config tuning like any other
-- key.
-- =============================================================================

insert into public.pricing_config (key, currency, value, description) values
  ('message_file_credits', 'NGN', 2,
   'Flat surcharge added to a message''s word-count-based cost when it carries a generic file/document attachment (PDF, Office doc, zip, etc.) — additive, never a replacement for the word-count formula. Separate key from message_media_credits (photos) and message_audio_credits (voice notes) so each attachment kind can be priced independently.')
on conflict (key, currency) do nothing;

-- =============================================================================
-- Storage: widen chat-media's size ceiling and allowed MIME types to cover
-- real documents. Raising the bucket-wide limit (rather than a second,
-- file-only bucket) is a deliberate simplification — photos are already
-- resize/compressed client-side well under 5 MiB, and voice notes are
-- duration-capped, not size-capped, so neither gets materially bigger as a
-- side effect of this; it just stops being the binding constraint for
-- documents. 20 MiB per the explicit product decision on record.
--
-- MIME allow-list covers the common real-world document/archive/text
-- formats a "attach any file" picker will actually produce, deliberately
-- excluding executable/script types (.exe, .apk, .sh, and similar) —
-- the same "no executables" boundary WhatsApp's own document attachment
-- already draws, a real security posture rather than an oversight.
-- `application/octet-stream` was already allowed (used for e2ee's opaque
-- encrypted media blobs) and stays as the generic fallback some pickers
-- report for less common types; it does not widen what create-chat-media-
-- upload-url itself will mint a path for (see that function's own
-- EXTENSION_BY_KIND/ALLOWED_FILE_EXTENSIONS allow-list).
-- =============================================================================

update storage.buckets
set file_size_limit = 20971520, -- 20 MiB
    allowed_mime_types = array[
      'image/jpeg', 'image/png', 'image/webp',
      'audio/m4a', 'audio/mp4', 'audio/webm', 'audio/webm;codecs=opus',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.oasis.opendocument.presentation',
      'application/zip', 'application/x-zip-compressed',
      'text/plain', 'text/csv', 'application/json', 'text/xml', 'application/xml',
      'application/rtf',
      'application/octet-stream'
    ]
where id = 'chat-media';

-- =============================================================================
-- fn_send_message — full redefinition (drop + create, same convention
-- every prior migration that added a new trailing parameter to this
-- function has used — CREATE OR REPLACE alone won't do it, since an
-- added parameter is a different type signature) adding:
--   - 'file' to the media_type whitelist
--   - a new p_media_filename param, required and bounds-checked when
--     media_type = 'file' (sanity bounds only — see header comment on why
--     this doesn't need media_path's own strict ownership check)
--   - message_file_credits billing, same shared surcharge branch
--     image/audio already use
--   - media_filename threaded through to the actual insert
-- Everything else is byte-for-byte identical to the previously deployed
-- definition (20260929100000_e2ee_media_support.sql) — confirmed against
-- pg_get_functiondef before writing this, per this repo's own standing
-- practice of basing changes on the real deployed function, not just the
-- newest migration file.
-- =============================================================================

drop function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid, jsonb);

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
  p_reply_to_status_id uuid default null,
  p_envelopes jsonb default null,
  p_media_filename text default null
)
returns table(message_id uuid, credits_charged bigint, word_count integer, status text, payer_balance_after bigint)
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  v_envelope jsonb;
  v_byte_block_size bigint;
  v_byte_base_credits bigint;
  v_max_bytes bigint;
  v_byte_count bigint;
  v_first_ciphertext bytea;
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
    if p_media_type is null or p_media_type not in ('image', 'audio', 'file') then
      raise exception 'unsupported_media_type';
    end if;
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

    -- Filename is purely cosmetic (never used to derive or authorize the
    -- real Storage path — that's p_media_path, already validated above),
    -- so this is a sanity bound, not a trust-boundary check: must be
    -- present and a reasonable display-length string. 255 matches the
    -- common filesystem filename limit most OSes already enforce, not an
    -- arbitrary round number.
    if p_media_type = 'file' then
      if p_media_filename is null or length(trim(both from p_media_filename)) = 0 then
        raise exception 'invalid_media_filename';
      end if;
      if length(p_media_filename) > 255 then
        raise exception 'invalid_media_filename: exceeds 255 characters';
      end if;
    end if;
  end if;

  if v_thread.e2ee_status = 'active' then
    if p_envelopes is null or jsonb_typeof(p_envelopes) is distinct from 'array' or jsonb_array_length(p_envelopes) < 1 then
      raise exception 'e2ee_envelopes_required';
    end if;

    for v_envelope in select * from jsonb_array_elements(p_envelopes) loop
      if not exists (
        select 1 from e2ee_devices
        where id = (v_envelope->>'recipient_device_id')::uuid
          and user_id = v_status_poster_id
          and revoked_at is null
      ) then
        raise exception 'invalid_envelope_recipient_device';
      end if;
    end loop;

    v_word_count := 0;
  else
    v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
    if length(trim(both from p_body)) = 0 then
      v_word_count := 0;
    end if;
    if v_word_count < 1 and not v_has_media then
      raise exception 'empty_message';
    end if;
  end if;

  select id, balance, is_frozen, currency into v_payer_wallet_id, v_payer_balance, v_payer_frozen, v_payer_currency
  from wallets
  where user_id = v_thread.payer_id and kind = 'topup_credit'
  for update;

  if v_payer_frozen then
    raise exception 'wallet_frozen';
  end if;

  select value into v_refund_hours from pricing_config where key = 'escrow_unanswered_refund_hours';

  if v_thread.e2ee_status = 'active' then
    select value into v_byte_block_size from pricing_config where key = 'message_byte_block_size' and currency = v_payer_currency;
    select value into v_byte_base_credits from pricing_config where key = 'message_byte_base_credits' and currency = v_payer_currency;
    select value into v_max_bytes from pricing_config where key = 'message_max_bytes' and currency = v_payer_currency;
    if v_byte_block_size is null or v_byte_base_credits is null or v_max_bytes is null then
      raise exception 'pricing_config_not_found_for_currency: message_byte_* %', v_payer_currency;
    end if;

    v_first_ciphertext := decode(p_envelopes->0->>'ciphertext', 'base64');
    v_byte_count := greatest(length(v_first_ciphertext) - 16, 0);

    if v_byte_count > v_max_bytes then
      raise exception 'message_too_long: % bytes exceeds max of %', v_byte_count, v_max_bytes;
    end if;
  else
    select value into v_max_words from pricing_config where key = 'message_max_words' and currency = v_payer_currency;

    if v_max_words is null then
      raise exception 'pricing_config_not_found_for_currency: message_max_words %', v_payer_currency;
    end if;

    if v_word_count > v_max_words then
      raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
    end if;
  end if;

  v_is_free_status_reply :=
    p_reply_to_status_id is not null
    and not v_has_media
    and not exists (select 1 from messages where thread_id = p_thread_id and sender_id = p_sender_id);

  if v_is_free_status_reply then
    v_credits := 0;
    v_message_status := 'sent';
  else
    if v_thread.e2ee_status = 'active' then
      v_credits := v_byte_base_credits * greatest(ceil(v_byte_count::numeric / v_byte_block_size), 1);
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
    end if;

    if v_has_media then
      if p_media_type = 'audio' then
        select value into v_media_credits from pricing_config where key = 'message_audio_credits' and currency = v_payer_currency;
        if v_media_credits is null then
          raise exception 'pricing_config_not_found_for_currency: message_audio_credits %', v_payer_currency;
        end if;
      elsif p_media_type = 'file' then
        select value into v_media_credits from pricing_config where key = 'message_file_credits' and currency = v_payer_currency;
        if v_media_credits is null then
          raise exception 'pricing_config_not_found_for_currency: message_file_credits %', v_payer_currency;
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
    duration_seconds, waveform_samples, reply_to_status_id, media_filename
  )
  values (
    p_thread_id, p_sender_id,
    case when v_thread.e2ee_status = 'active' then null else p_body end,
    v_word_count, v_credits, v_message_status,
    p_client_message_id, p_reply_to_message_id, coalesce(p_is_forwarded, false),
    p_media_path, p_media_type,
    case when p_media_type = 'audio' then p_duration_seconds else null end,
    case when p_media_type = 'audio' then p_waveform_samples else null end,
    p_reply_to_status_id,
    case when p_media_type = 'file' then p_media_filename else null end
  )
  returning id into v_message_id;

  if v_thread.e2ee_status = 'active' then
    for v_envelope in select * from jsonb_array_elements(p_envelopes) loop
      insert into e2ee_message_envelopes (
        message_id, recipient_device_id, ciphertext, ratchet_public_key,
        previous_chain_length, message_number,
        x3dh_sender_identity_key, x3dh_sender_ephemeral_key, x3dh_one_time_prekey_id
      ) values (
        v_message_id,
        (v_envelope->>'recipient_device_id')::uuid,
        decode(v_envelope->>'ciphertext', 'base64'),
        decode(v_envelope->>'ratchet_public_key', 'base64'),
        (v_envelope->>'previous_chain_length')::integer,
        (v_envelope->>'message_number')::integer,
        case when v_envelope->>'x3dh_sender_identity_key' is not null then decode(v_envelope->>'x3dh_sender_identity_key', 'base64') else null end,
        case when v_envelope->>'x3dh_sender_ephemeral_key' is not null then decode(v_envelope->>'x3dh_sender_ephemeral_key', 'base64') else null end,
        (v_envelope->>'x3dh_one_time_prekey_id')::integer
      );
    end loop;
  end if;

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
$function$;

revoke execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid, jsonb, text) to service_role;

-- =============================================================================
-- fn_delete_message_for_everyone — add media_filename to the fields
-- blanked on delete, same treatment media_path/media_type/duration_
-- seconds/waveform_samples/audio_played_at already get. Everything else
-- byte-for-byte identical to the previously deployed definition.
-- =============================================================================

create or replace function public.fn_delete_message_for_everyone(p_message_id uuid, p_sender_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
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
      duration_seconds = null, waveform_samples = null, audio_played_at = null,
      media_filename = null
  where id = p_message_id;

  delete from e2ee_message_envelopes where message_id = p_message_id;

  return v_message.media_path;
end;
$function$;

revoke execute on function public.fn_delete_message_for_everyone(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_delete_message_for_everyone(uuid, uuid) to service_role;
