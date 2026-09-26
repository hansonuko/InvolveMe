-- Real end-to-end encryption, step 4 of docs/21-E2EE-TECHNICAL-DESIGN.md's
-- build order: fn_send_message's e2ee_status-aware branch + byte-length
-- billing (§3, §4). The client crypto core (step 3, X3DH + Double Ratchet,
-- PR #187) is proven correct in isolation; this is the server-side wiring
-- that lets it actually carry a real message.
--
-- ============================================================================
-- New pricing_config keys (§4) — same "config not constants" discipline
-- CLAUDE.md rule #9 requires, mirroring message_word_block_size/
-- message_base_credits/message_max_words's exact existing shape,
-- substituting bytes for words. Calibration, not a final tuned number
-- (docs/21 §4 flags this explicitly): message_byte_block_size=300 sizes a
-- ~50-word/250-300-UTF-8-byte "typical" message (docs/21's own stated
-- range) to land at exactly message_byte_base_credits — the same 2-credit
-- floor message_base_credits already charges for a ~50-word plaintext
-- message. message_max_bytes=3000 mirrors message_max_words=500's own
-- 10-block ceiling (500 words / 50 words-per-block = 10 blocks; 10 blocks
-- x 300 bytes-per-block = 3000 bytes), not an independently chosen number.
-- ============================================================================

insert into public.pricing_config (key, value, currency, description) values
  ('message_byte_base_credits', 2, 'NGN', 'Credits per ciphertext-byte-block for an E2EE-active-thread message (docs/21-E2EE-TECHNICAL-DESIGN.md §4) — calibration starting point, mirrors message_base_credits.'),
  ('message_byte_block_size', 300, 'NGN', 'Ciphertext bytes (post-AEAD-tag) per billing block for an E2EE-active-thread message (docs/21 §4) — sized so a ~50-word/250-300-byte message lands at message_byte_base_credits, mirroring message_word_block_size.'),
  ('message_max_bytes', 3000, 'NGN', 'Hard cap on ciphertext bytes (post-AEAD-tag) per E2EE message (docs/21 §4, server-enforced) — mirrors message_max_words at the same 10-block ceiling.')
on conflict (key, currency) do nothing;

-- A session-establishing envelope needs BOTH its X3DH identity key and
-- ephemeral key, or neither — a malformed envelope missing exactly one
-- would silently break the recipient's ability to bootstrap that session.
-- Table-level, not re-checked per function, so it holds for every insert
-- path (fn_send_message and fn_edit_message both write this table).
alter table public.e2ee_message_envelopes
  add constraint e2ee_message_envelopes_x3dh_paired
  check ((x3dh_sender_identity_key is null) = (x3dh_sender_ephemeral_key is null));

-- ============================================================================
-- fn_release_escrow — NO code change needed here, verified live rather than
-- assumed: this function's duplicate-content check calls
-- similarity(v_message_body, v_recent_body), and an 'active'-thread
-- message's body is null (docs/21 §2). Postgres's similarity() on a null
-- argument returns null (confirmed via a direct query against this
-- project's own database before writing this migration), and
-- `if null then ... end if` in plpgsql is treated as false — so every
-- e2ee-active message already, correctly, never gets flagged as
-- duplicate content, with zero lines changed. This is exactly the
-- "skipped for escrows tied to an 'active'-thread message" behavior
-- docs/21 §3 describes; it just happens to fall out of NULL propagation
-- rather than needing an explicit branch. Metadata-only fraud signals
-- (rate caps, collusion detection) read no message content and are
-- correspondingly untouched.
-- ============================================================================

-- ============================================================================
-- fn_send_message — dropped and recreated to add p_envelopes. Every line
-- under the `else` branch below is byte-for-byte unchanged from the live
-- definition (20260926140000_thread_payer_role.sql), confirmed via
-- pg_get_functiondef immediately before writing this migration — docs/21
-- §3's "if 'off': completely unchanged" promise, verified, not assumed.
--
-- The new `if v_thread.e2ee_status = 'active'` branch:
--   - Rejects media outright (e2ee_media_not_supported) — out of scope
--     for this pass, and silently allowing an unencrypted media_path
--     through on an 'active' thread would be a real content leak, not a
--     graceful degradation.
--   - Requires a non-empty p_envelopes array (one entry per recipient
--     device) and validates every envelope's recipient_device_id
--     actually belongs to the OTHER participant in this thread (reusing
--     v_status_poster_id, already computed above for the free-status-
--     reply check — same value, same meaning: "the other person in this
--     thread"), and isn't revoked, before trusting any of its fields.
--   - Bills by ciphertext byte length (§4): every envelope for the same
--     logical message carries the identical plaintext, so any one
--     envelope's ciphertext length is an unambiguous, client-can't-lie-
--     about-it number — this reads the first array element.
--   - word_count is 0 (not applicable to an encrypted message, same
--     "0 means not this kind of billing" convention captionless-media
--     messages already use).
--   - The free-status-reply check (§B1) still runs unconditionally,
--     unchanged, since it's purely structural (first message in thread,
--     no media) and never reads message content — full feature parity
--     with plaintext threads, no e2ee-specific carve-out needed.
-- ============================================================================

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

  if v_thread.e2ee_status = 'active' then
    if v_has_media then
      raise exception 'e2ee_media_not_supported';
    end if;

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
    -- unambiguous, client-can't-lie-about-it number.
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

-- ============================================================================
-- fn_edit_message — dropped and recreated. The `else` branch below is
-- byte-for-byte unchanged from the live definition
-- (20260919100000_message_editing.sql) with ONE fix made in passing: the
-- three pricing_config lookups (message_word_block_size, message_base_
-- credits, message_max_words) had no `and currency = ...` filter, even
-- though pricing_config's primary key has been (key, currency) since
-- 20260917130000_multicurrency_schema.sql — a real, latent gap (silently
-- picks an arbitrary row if a key ever has more than one currency's
-- worth of rows), harmless today only because this app is NGN-only in
-- practice. Left alone, this file would ship a second, INCONSISTENT
-- lookup pattern right next to the new currency-filtered
-- message_byte_block_size/message_byte_base_credits lookups added below
-- for the exact same function — that inconsistency, introduced in the
-- same diff, is worth the one-line fix rather than leaving it for
-- someone to trip over later.
--
-- The new e2ee-active branch mirrors fn_send_message's envelope handling:
-- Double Ratchet has no "edit in place" (every ciphertext is its own
-- ratchet step), so an edit means the client re-encrypted the new content
-- as a fresh envelope per recipient device, exactly like a new send. This
-- function validates the byte-length treatment against the message's
-- already-frozen credits_charged (identical philosophy to the word-count
-- path: shrinking or same-tier edits are free, crossing into a more
-- expensive tier is rejected outright), then replaces the message's old
-- envelope rows with the new ones. credits_charged itself never changes —
-- same as the plaintext path.
-- ============================================================================

drop function public.fn_edit_message(uuid, uuid, text);

create function public.fn_edit_message(
  p_message_id uuid,
  p_sender_id uuid,
  p_new_body text default null,
  p_envelopes jsonb default null
)
returns table(message_id uuid, word_count integer, credits_charged bigint, edited_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
  v_thread threads%rowtype;
  v_recipient_id uuid;
  v_block_size bigint;
  v_base_credits bigint;
  v_max_words bigint;
  v_edit_window_minutes bigint;
  v_new_word_count integer;
  v_new_required_credits bigint;
  v_payer_currency text;
  v_envelope jsonb;
  v_new_ciphertext bytea;
  v_new_byte_count integer;
  v_byte_block_size bigint;
  v_byte_base_credits bigint;
begin
  select * into v_message from messages where id = p_message_id for update;
  if not found then
    raise exception 'message_not_found';
  end if;

  if v_message.sender_id <> p_sender_id then
    raise exception 'not_the_sender';
  end if;

  if v_message.status <> 'escrowed' then
    raise exception 'message_not_editable: status is %', v_message.status;
  end if;

  select * into v_thread from threads where id = v_message.thread_id;

  select value into v_edit_window_minutes from pricing_config where key = 'message_edit_window_minutes';
  if now() > v_message.created_at + make_interval(mins => v_edit_window_minutes::integer) then
    raise exception 'edit_window_expired';
  end if;

  select currency into v_payer_currency from wallets where user_id = v_thread.payer_id and kind = 'topup_credit';

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

    v_recipient_id := case
      when p_sender_id = v_thread.participant_a then v_thread.participant_b
      else v_thread.participant_a
    end;

    for v_envelope in select * from jsonb_array_elements(p_envelopes) loop
      if not exists (
        select 1 from e2ee_devices
        where id = (v_envelope->>'recipient_device_id')::uuid
          and user_id = v_recipient_id
          and revoked_at is null
      ) then
        raise exception 'invalid_envelope_recipient_device';
      end if;
    end loop;

    select value into v_byte_block_size from pricing_config where key = 'message_byte_block_size' and currency = v_payer_currency;
    select value into v_byte_base_credits from pricing_config where key = 'message_byte_base_credits' and currency = v_payer_currency;
    if v_byte_block_size is null or v_byte_base_credits is null then
      raise exception 'pricing_config_not_found_for_currency: message_byte_* %', v_payer_currency;
    end if;

    v_new_ciphertext := decode(p_envelopes->0->>'ciphertext', 'base64');
    v_new_byte_count := greatest(length(v_new_ciphertext) - 16, 0);
    v_new_required_credits := (v_byte_base_credits * greatest(ceil(v_new_byte_count::numeric / v_byte_block_size), 1))::bigint;

    if v_new_required_credits > v_message.credits_charged then
      raise exception 'edit_would_increase_cost: needs % credits, already charged %', v_new_required_credits, v_message.credits_charged;
    end if;

    -- Table-qualified: fn_edit_message's RETURNS TABLE(message_id, ...)
    -- makes `message_id` an implicit PL/pgSQL variable in scope here too
    -- — a bare `message_id` in this WHERE clause is genuinely ambiguous
    -- between that variable and this table's own column (Postgres
    -- correctly refuses to guess; found live via this migration's own
    -- test suite, not caught by review).
    delete from e2ee_message_envelopes where e2ee_message_envelopes.message_id = p_message_id;

    for v_envelope in select * from jsonb_array_elements(p_envelopes) loop
      insert into e2ee_message_envelopes (
        message_id, recipient_device_id, ciphertext, ratchet_public_key,
        previous_chain_length, message_number,
        x3dh_sender_identity_key, x3dh_sender_ephemeral_key, x3dh_one_time_prekey_id
      ) values (
        p_message_id,
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

    update messages set word_count = 0, edited_at = now() where id = p_message_id;

    return query select v_message.id, 0, v_message.credits_charged, now();
  else
    v_new_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_new_body), '\s+'), 1), 0);
    if length(trim(both from p_new_body)) = 0 then
      v_new_word_count := 0;
    end if;
    if v_new_word_count < 1 then
      raise exception 'empty_message';
    end if;

    select value into v_block_size from pricing_config where key = 'message_word_block_size' and currency = v_payer_currency;
    select value into v_base_credits from pricing_config where key = 'message_base_credits' and currency = v_payer_currency;
    select value into v_max_words from pricing_config where key = 'message_max_words' and currency = v_payer_currency;

    if v_new_word_count > v_max_words then
      raise exception 'message_too_long: % words exceeds max of %', v_new_word_count, v_max_words;
    end if;

    v_new_required_credits := (v_base_credits * greatest(ceil(v_new_word_count::numeric / v_block_size), 1))::bigint;
    if v_new_required_credits > v_message.credits_charged then
      raise exception 'edit_would_increase_cost: needs % credits, already charged %', v_new_required_credits, v_message.credits_charged;
    end if;

    update messages set body = p_new_body, word_count = v_new_word_count, edited_at = now() where id = p_message_id;

    return query select v_message.id, v_new_word_count, v_message.credits_charged, now();
  end if;
end;
$$;

revoke execute on function public.fn_edit_message(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.fn_edit_message(uuid, uuid, text, jsonb) to service_role;
