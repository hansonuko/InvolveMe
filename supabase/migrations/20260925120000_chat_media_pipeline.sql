-- Chat media (photo) pipeline — docs/16-CHAT-MEDIA-SCOPING.md, built per
-- explicit user go-ahead following that scoping pass. Mirrors the
-- status-media pipeline's shape everywhere it applies
-- (20260917140000_status_media_pipeline.sql): private bucket, no direct
-- client write (signed upload URL only), reads gated by a storage.objects
-- RLS policy re-deriving the owning table's own visibility rule, delete
-- only through the real Storage API. Photo only, no video — same "stay
-- lite, no heavy transcoding dependency" reasoning status media already
-- established (docs/16 §2).
--
-- One real gap in that precedent this migration does NOT repeat:
-- fn_post_status never verifies a caller-supplied p_media_path was
-- actually issued to that caller (create-status-upload-url always mints
-- `${user.id}/${uuid}.jpg`, but fn_post_status trusts whatever path string
-- it's given) — meaning a user could currently post someone else's real
-- status-media path as their own, and status_media_select_visible would
-- then let their own thread partners view it, a real cross-account
-- privacy leak. Out of scope to fix here (a pre-existing gap in a
-- different feature, not introduced by this migration), but flagged
-- rather than silently carried forward: fn_send_message below DOES
-- validate the path prefix, closing this class of gap for chat media from
-- day one.

-- =============================================================================
-- messages: media columns, both nullable — a text-only message (the
-- overwhelming majority, unchanged) leaves both null. word_count's own
-- CHECK constraint required at least 1 word; a caption-less photo message
-- genuinely has zero, so it's relaxed to >= 0 rather than worked around
-- with a fake placeholder word.
-- =============================================================================

alter table public.messages add column media_path text;
alter table public.messages add column media_type text;

alter table public.messages drop constraint messages_word_count_check;
alter table public.messages add constraint messages_word_count_check check (word_count >= 0);

-- =============================================================================
-- New pricing_config key — never hardcoded (CLAUDE.md rule #9). Seeded so
-- a bare captionless photo (message_base_credits' own word_count=0 floor
-- already charges 1 word-block's worth, 2 credits, + this 4-credit
-- surcharge = 6) costs the same as a media status post
-- (status_upload_credits_media = 6) — a deliberate cross-feature
-- consistency point, not a coincidence, and a reasonable v1 default
-- subject to the usual pricing_config tuning, not a permanent constant.
-- =============================================================================

insert into public.pricing_config (key, currency, value, description) values
  ('message_media_credits', 'NGN', 4,
   'Flat surcharge added to a message''s word-count-based cost when it carries a photo attachment (docs/16-CHAT-MEDIA-SCOPING.md §3) — additive, never a replacement for the word-count formula.')
on conflict (key, currency) do nothing;

-- =============================================================================
-- Storage: chat-media bucket. Same posture as status-media — private,
-- write only via a service-role-minted signed upload URL (no INSERT
-- policy for `authenticated` at all), read/delete gated below.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  false,
  5242880, -- 5 MiB — matches status-media's own ceiling; a client-side-
           -- compressed single image (docs/01-ARCHITECTURE.md §5's 1600px/
           -- WebP target) should never approach this.
  array['image/jpeg', 'image/png', 'image/webp']
);

-- SELECT: an object is readable if some message's media_path matches its
-- name AND the caller is a participant in that message's thread — the
-- exact same predicate messages_select_participant
-- (20260912072749_rls_policies.sql) already encodes, repeated here for
-- the same "RLS can't reference another table's policy" reason
-- status_media_select_visible's own comment already gives. No blocked-
-- thread carve-out, matching messages_select_participant itself (a
-- blocked thread's existing messages stay readable; only new sends are
-- blocked).
create policy chat_media_select_visible on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.messages m
      join public.threads t on t.id = m.thread_id
      where m.media_path = storage.objects.name
        and (t.participant_a = auth.uid() or t.participant_b = auth.uid())
    )
  );

-- DELETE: the sender's own media only, and only while the owning message
-- row still references it. Not actually load-bearing today (the real
-- delete path is delete-message-for-everyone, running as service_role,
-- which bypasses RLS entirely) — included anyway for defense-in-depth and
-- consistency with status_media_delete_own, in case a direct-client
-- delete path is ever added.
create policy chat_media_delete_own on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.messages m
      where m.media_path = storage.objects.name
        and m.sender_id = auth.uid()
    )
  );

-- =============================================================================
-- fn_send_message — dropped and recreated. Every line outside the media
-- block is copied verbatim from the live definition
-- (20260925090000_message_pricing_strategy_framework.sql), confirmed via
-- pg_get_functiondef immediately before writing this migration. Real
-- changes:
--
--   1. Two new trailing default-valued params, p_media_path/p_media_type
--      — trailing, so every existing caller (send-message Edge Function,
--      any test) keeps working unchanged.
--   2. p_media_path ownership check: must be prefixed `${p_sender_id}/`,
--      the exact path shape create-chat-media-upload-url mints (server-
--      derived from the caller's own verified JWT, never client-chosen) —
--      closes the cross-account path-reuse gap this migration's header
--      comment flags in fn_post_status, for this new pipeline.
--   3. p_media_type, when media is present, must be exactly 'image' —
--      the only value this pipeline ever mints; a hard fail-closed check
--      now costs nothing and avoids ever silently accepting a future
--      client sending something this pipeline doesn't actually support.
--   4. The empty-message guard only fires when there's neither body text
--      nor media — a captionless photo is a real, valid message.
--   5. message_media_credits added on top of the strategy-computed price
--      when media is present (docs/16 §3) — additive, after pricing, not
--      part of any of the three strategy functions themselves (media
--      isn't word-count-shaped, so it doesn't belong inside them).
--   6. media_path/media_type inserted into the new messages row.
-- =============================================================================

drop function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean);

create function public.fn_send_message(
  p_thread_id uuid,
  p_sender_id uuid,
  p_body text,
  p_client_message_id uuid default null,
  p_reply_to_message_id uuid default null,
  p_is_forwarded boolean default false,
  p_media_path text default null,
  p_media_type text default null
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
    if p_media_type is distinct from 'image' then
      raise exception 'unsupported_media_type';
    end if;
    -- The path-ownership check above only proves the path was *minted*
    -- for this sender (create-chat-media-upload-url always issues
    -- `${user.id}/${uuid}.jpg`) — it says nothing about whether the
    -- client's own upload to it actually succeeded before calling this.
    -- Charging for, and creating, a "photo message" with nothing behind
    -- it would be a real correctness bug the recipient would just see as
    -- a permanently broken image — worth one extra existence check on
    -- what is otherwise a rare, defensive path (the client only ever
    -- calls this after its own upload already reported success).
    if not exists (
      select 1 from storage.objects where bucket_id = 'chat-media' and name = p_media_path
    ) then
      raise exception 'media_not_found';
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
    select value into v_media_credits from pricing_config where key = 'message_media_credits' and currency = v_payer_currency;
    if v_media_credits is null then
      raise exception 'pricing_config_not_found_for_currency: message_media_credits %', v_payer_currency;
    end if;
    v_credits := v_credits + v_media_credits;
  end if;

  if v_payer_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_payer_balance;
  end if;

  insert into messages (
    thread_id, sender_id, body, word_count, credits_charged, status,
    client_message_id, reply_to_message_id, is_forwarded, media_path, media_type
  )
  values (
    p_thread_id, p_sender_id, p_body, v_word_count, v_credits, 'escrowed',
    p_client_message_id, p_reply_to_message_id, coalesce(p_is_forwarded, false),
    p_media_path, p_media_type
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

revoke execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text) to service_role;

-- =============================================================================
-- fn_delete_message_for_everyone — now also blanks media_path/media_type
-- (a deleted message's tombstone should carry no attachment reference,
-- same spirit as blanking body) and returns the media_path that was
-- cleared so the calling Edge Function can remove the actual Storage
-- object — a return-type change, hence drop + recreate rather than
-- create-or-replace, same convention this migration's fn_send_message
-- change above and fn_post_status's own signature change already follow.
-- =============================================================================

drop function public.fn_delete_message_for_everyone(uuid, uuid);

create function public.fn_delete_message_for_everyone(p_message_id uuid, p_sender_id uuid)
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
  set body = '', deleted_for_everyone = true, media_path = null, media_type = null
  where id = p_message_id;

  return v_message.media_path;
end;
$$;

revoke execute on function public.fn_delete_message_for_everyone(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_delete_message_for_everyone(uuid, uuid) to service_role;
