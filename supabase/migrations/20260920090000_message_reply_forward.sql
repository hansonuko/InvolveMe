-- Chat-screen message actions parity pass (reply, forward) — closing a real
-- gap flagged directly by the user: neither existed anywhere in 1:1 chat,
-- and the multi-select/delete feature (punch-list item 5) made the
-- existing action-sheet-per-message pattern feel like it had swallowed
-- Edit, when Edit was actually just correctly hidden once a message
-- settles (docs/03-ECONOMY-LEDGER.md: editing stops once escrow releases).
-- The real fix is discoverability, not a server bug — see the mobile
-- redesign in the same PR for the WhatsApp-style selection header this
-- migration's new columns support.
--
-- A forwarded message is still billed exactly like any other message
-- (CLAUDE.md rule #1/#8's word-count formula, unmodified) — `is_forwarded`
-- is display-only metadata (renders a small "Forwarded" tag client-side),
-- never a pricing signal. Making forwards free would both contradict the
-- documented economy and open an obvious exploit (relabel any send as a
-- "forward" to dodge billing), so this deliberately does not touch
-- fn_send_message's pricing math at all.

alter table public.messages add column reply_to_message_id uuid references public.messages (id);
alter table public.messages add column is_forwarded boolean not null default false;

create index messages_reply_to_message_id_idx on public.messages (reply_to_message_id);

drop function public.fn_send_message(uuid, uuid, text, uuid);

create function public.fn_send_message(
  p_thread_id uuid,
  p_sender_id uuid,
  p_body text,
  p_client_message_id uuid default null,
  p_reply_to_message_id uuid default null,
  p_is_forwarded boolean default false
)
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

  -- The quoted message must be a real message in this exact thread — never
  -- trusted as "some uuid the client sent," since RLS on `messages` would
  -- otherwise be the only thing stopping a quote pointing into a thread the
  -- sender has no part of.
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

-- =============================================================================
-- Forward targets can be a group thread too (the "Forward" flow lists both
-- 1:1 threads and groups) — group_messages needs the same display-only
-- is_forwarded tag for a consistent "Forwarded" label regardless of which
-- kind of chat a message lands in. No reply_to_message_id here: this pass
-- scopes quoted replies to 1:1 chat only (see the mobile PR's own notes on
-- why group parity is a flagged follow-up, not silently dropped).
-- =============================================================================

alter table public.group_messages add column is_forwarded boolean not null default false;

drop function public.fn_send_group_message_free(uuid, uuid, text, uuid);

create function public.fn_send_group_message_free(
  p_group_thread_id uuid,
  p_sender_id uuid,
  p_body text,
  p_client_message_id uuid default null,
  p_is_forwarded boolean default false
)
returns table (
  message_id uuid,
  word_count integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_word_count integer;
  v_max_words bigint;
  v_message_id uuid;
  v_created_at timestamptz;
  v_existing record;
begin
  if not exists (select 1 from group_threads where id = p_group_thread_id) then
    raise exception 'group_not_found';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_sender_id
  ) then
    raise exception 'not_a_member';
  end if;

  if p_client_message_id is not null then
    select group_messages.id, group_messages.word_count, group_messages.created_at
      into v_existing
      from group_messages
      where sender_id = p_sender_id and client_message_id = p_client_message_id;

    if found then
      return query select v_existing.id, v_existing.word_count, v_existing.created_at;
      return;
    end if;
  end if;

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 then
    raise exception 'empty_message';
  end if;

  select value into v_max_words from pricing_config where key = 'message_max_words';
  if v_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
  end if;

  begin
    insert into group_messages (
      group_thread_id, sender_id, body, word_count, credits_charged,
      owner_earning_credits, platform_take_credits, client_message_id, is_forwarded
    )
    values (
      p_group_thread_id, p_sender_id, p_body, v_word_count, 0, 0, 0,
      p_client_message_id, coalesce(p_is_forwarded, false)
    )
    returning id, group_messages.created_at into v_message_id, v_created_at;
  exception when unique_violation then
    select id, group_messages.created_at into v_message_id, v_created_at
      from group_messages
      where sender_id = p_sender_id and client_message_id = p_client_message_id;
  end;

  update group_threads set last_message_at = v_created_at where id = p_group_thread_id;

  return query select v_message_id, v_word_count, v_created_at;
end;
$$;

revoke execute on function public.fn_send_group_message_free(uuid, uuid, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.fn_send_group_message_free(uuid, uuid, text, uuid, boolean) to service_role;
