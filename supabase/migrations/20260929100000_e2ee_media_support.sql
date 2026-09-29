-- Real end-to-end encryption, encrypted media (explicit follow-up request,
-- session 37/38, after the crypto layer itself was found broken end-to-end
-- and fixed live — docs/21's own residual-gaps list always scoped media
-- as "out of scope for this pass," never "impossible," and the reason it
-- was hard-rejected server-side (`e2ee_media_not_supported`) was never a
-- crypto limitation, just unbuilt).
--
-- Design, matching how every real e2e-encrypted messaging app (Signal,
-- WhatsApp) actually handles attachments — encrypt the file, transport the
-- key through the already-encrypted message channel, never touch the
-- ratchet/session/envelope machinery itself:
--
--   1. The client generates a random symmetric key + nonce PER ATTACHMENT
--      and encrypts the file's bytes with it (XChaCha20-Poly1305, the
--      exact same AEAD primitive this app's message encryption already
--      uses — no new cryptographic primitive introduced for this).
--   2. The CIPHERTEXT (not the plaintext file) is uploaded through the
--      existing chat-media pipeline unchanged — from Storage's own
--      perspective this was already always "opaque bytes at a path,"
--      encrypted or not.
--   3. The attachment key + nonce are carried inside the SAME Double
--      Ratchet envelope that already carries a message's text — a caption
--      is no longer just a string, it's a small JSON payload
--      (`{text, mediaKey, mediaNonce}`) that gets encrypted exactly like
--      plain text always has been. No schema change to
--      e2ee_message_envelopes, no change to x3dh.ts/doubleRatchet.ts at
--      all — the ratchet has no idea it's carrying a media key instead of
--      a sentence, and doesn't need to.
--
-- What this migration actually changes, therefore, is narrow: stop
-- rejecting media on an e2ee-active thread outright, run it through
-- EXACTLY the same media validation (path ownership, declared type,
-- upload-actually-happened, audio duration/waveform bounds) non-e2ee
-- media already gets — moved out of the e2ee/non-e2ee branch split so
-- there's one copy of this validation, not two that can drift — and bill
-- it with the SAME flat message_media_credits/message_audio_credits
-- surcharge non-e2ee media already uses, on top of the byte-based caption
-- billing. That billing choice is the one real design decision here, not
-- a mechanical carry-over: an e2ee message's byte-based billing measures
-- ONE envelope's ciphertext length, which for a media message only ever
-- contains the small {text, mediaKey, mediaNonce} JSON blob — NOT the
-- actual attachment, which is uploaded separately to Storage and never
-- touches the envelope at all. Billing an attachment by "envelope size"
-- would measure the wrong thing entirely and let a multi-megabyte photo
-- or voice note through for the price of a short text message — the same
-- flat per-attachment surcharge non-e2ee media already charges sidesteps
-- that by construction, since it was never based on measuring content
-- size to begin with.

-- Storage: widen chat-media's allowed_mime_types for encrypted uploads.
-- Once XChaCha20-Poly1305'd, an attachment's bytes are no longer a valid
-- JPEG/PNG/WebP/M4A — none of those MIME types describe them truthfully
-- any more, and this app never wants to lie in a Content-Type header (a
-- decrypt-before-render app has no reason to and it'd only confuse
-- anything downstream that trusts the header). 'application/octet-stream'
-- is the correct, honest declaration for opaque encrypted bytes; the
-- existing plaintext types stay for non-e2ee threads, which upload the
-- real file unchanged exactly as before.
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'audio/m4a', 'audio/mp4', 'application/octet-stream']
where id = 'chat-media';

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
  p_envelopes jsonb default null
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

  -- docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1 — validated up
  -- front, unconditionally, before we know whether it'll be free. This is
  -- "the other participant in this thread," a structural fact independent
  -- of who currently pays, so it deliberately still reads
  -- participant_a/participant_b, not payer_id/v_payee_id. Reused below
  -- (e2ee branch) as the required owner of every envelope's recipient
  -- device — same meaning, same value, no separate variable needed.
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

  -- Media validation — identical regardless of e2ee_status (session 37/38:
  -- the file at p_media_path is opaque bytes either way, plaintext or
  -- client-side-encrypted ciphertext; the server only ever validates path
  -- ownership, declared type, that the upload actually completed, and
  -- (for audio) duration/waveform bounds). Previously duplicated inside
  -- the non-e2ee branch only, since e2ee rejected media outright — moved
  -- here, shared, so an e2ee-active thread gets exactly the same checks a
  -- plaintext one always has, not a second copy that can drift out of
  -- sync with this one.
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

  if v_thread.e2ee_status = 'active' then
    -- jsonb_typeof guards jsonb_array_length below, which errors outright
    -- ("cannot get array length of a scalar") rather than returning
    -- anything falsy on non-array input — a JSON `null` scalar (distinct
    -- from a true SQL NULL, and a real possibility depending on how a
    -- caller's JSON-to-jsonb binding treats an absent/null field) hits
    -- exactly this: p_envelopes is null is false for it, so the length
    -- check would run and crash instead of raising this function's own
    -- clean error. Found live via this migration's own test suite.
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

    -- §4: every envelope for the same logical message carries identical
    -- plaintext, so any one envelope's ciphertext length is an
    -- unambiguous, client-can't-lie-about-it number. For a media message
    -- this plaintext is the small {text, mediaKey, mediaNonce} JSON blob,
    -- NOT the attachment itself (see this migration's own header) — the
    -- attachment is billed separately via the flat surcharge below.
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

  -- docs/18 §B1 — free only for the sender's genuinely first message in
  -- this thread, evaluated before this message's own insert, and only
  -- when it carries no media (media keeps its own separate billing).
  -- Unconditional on e2ee_status: purely structural, reads no content.
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

    -- Media surcharge — identical regardless of e2ee_status, added on top
    -- of whichever base billing (byte-based or word-based-via-strategy)
    -- just ran above. Previously only ever reachable from the non-e2ee
    -- branch (e2ee media was rejected outright); now shared so e2ee media
    -- gets the same real surcharge instead of silently dodging it, and
    -- there's one copy of this lookup instead of two.
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
    p_thread_id, p_sender_id,
    case when v_thread.e2ee_status = 'active' then null else p_body end,
    v_word_count, v_credits, v_message_status,
    p_client_message_id, p_reply_to_message_id, coalesce(p_is_forwarded, false),
    p_media_path, p_media_type,
    case when p_media_type = 'audio' then p_duration_seconds else null end,
    case when p_media_type = 'audio' then p_waveform_samples else null end,
    p_reply_to_status_id
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
$$;

revoke execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text, integer, smallint[], uuid, jsonb) to service_role;
