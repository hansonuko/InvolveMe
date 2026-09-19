-- Punch-list item 2 (2026-09-19): message editing. Read docs/03-ECONOMY-
-- LEDGER.md §4/§5 and docs/06-SECURITY-FRAUD-LOOPHOLES.md before writing
-- this, per CLAUDE.md's standing instruction for anything touching
-- messages/credits — this feature sits directly on top of the escrow
-- lifecycle, not beside it, and the two obvious naive implementations
-- both reopen exploits this project has already spent real effort
-- closing:
--
-- 1. "Just let the sender UPDATE messages.body" — messages has no client
--    UPDATE policy at all (only messages_select_participant exists); every
--    write goes through a SECURITY DEFINER function, same posture as
--    fn_send_message. A raw client UPDATE was never on the table.
-- 2. "Re-run the billing formula on the new body and charge the
--    difference" — this is explicitly what the user asked NOT to build
--    ("edited messages cannot be charged twice"), and it would also
--    reopen the exact §1 exploit docs/06 already closed once: send a
--    cheap 1-word message, then edit it into the full 500-word cap for
--    free if editing ever recomputed and charged a *smaller* delta than
--    a fresh send would cost.
--
-- The actual design: editing never touches billing at all. The original
-- credits_charged / escrow amount is exactly what was paid and exactly
-- what stays paid, whether the message is edited or not. What editing
-- *is* allowed to do is bounded to prevent free upgrades:
--
-- - Only the original sender, only while the message is still
--   'escrowed' (the payee hasn't replied yet and the 48h refund window
--   hasn't expired) - once 'released' (payee already got paid based on
--   the original content) or 'refunded' (the payer already got their
--   credit back), the transaction that content represents is settled;
--   editing settled content after money already moved is exactly the
--   kind of "who absorbs it" ambiguity §5's rounding-policy comment
--   already flags as a support/legal risk in a different context - so
--   it's simply not allowed here, matching this codebase's existing
--   append-only-ledger posture (CLAUDE.md rule #4) applied to message
--   content instead of money.
-- - Only within message_edit_window_minutes of created_at (new config,
--   default 15 - the same real-world window WhatsApp itself uses, not
--   an arbitrary pick). This is a genuine second, independent piece of
--   fraud-surface reduction, not just UX parity: it bounds how long a
--   sender can sit on an escrowed message deciding whether to edit it,
--   narrowing (though not eliminating - see the tier check below) the
--   window where "wait and see if this needs padding out" is even worth
--   trying.
-- - The edited body's word count must not require *more* credits than
--   were already charged (comparing directly against the stored
--   messages.credits_charged, not recomputing "the original tier" from
--   current pricing_config - immune to a pricing_config change landing
--   between send and edit). This is the actual fix for the exploit in
--   point 2 above: shrinking or making same-tier edits is always fine
--   (the payer already paid for that many credits' worth and isn't
--   getting more value for free); crossing into a more expensive tier is
--   rejected outright with a clear error, not silently truncated -
--   truncating user text without telling them is worse than refusing
--   the edit and asking them to send a new message instead.
--
-- Row-level locking: fn_edit_message locks the messages row with
-- `for update` before checking status, the same discipline CLAUDE.md
-- rule #3 requires for money mutations, applied here because this
-- function's status check has a real concurrent-writer to race against:
-- fn_release_escrow (and the escrow-expiry-sweep cron behind it) also
-- writes messages.status, from a completely different code path, at any
-- time. Without the lock, a check-then-act race could let an edit land
-- on a message a concurrent release/refund is simultaneously settling.

alter table public.messages add column if not exists edited_at timestamptz;

insert into public.pricing_config (key, value, currency, description) values
  ('message_edit_window_minutes', 15, 'NGN', 'How long after sending a message can still be edited (docs/03-ECONOMY-LEDGER.md, punch-list item 2) - same real-world window WhatsApp itself uses.')
on conflict (key, currency) do nothing;

create or replace function public.fn_edit_message(p_message_id uuid, p_sender_id uuid, p_new_body text)
returns table(message_id uuid, word_count integer, credits_charged bigint, edited_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message messages%rowtype;
  v_block_size bigint;
  v_base_credits bigint;
  v_max_words bigint;
  v_edit_window_minutes bigint;
  v_new_word_count integer;
  v_new_required_credits bigint;
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

  select value into v_edit_window_minutes from pricing_config where key = 'message_edit_window_minutes';
  if now() > v_message.created_at + make_interval(mins => v_edit_window_minutes::integer) then
    raise exception 'edit_window_expired';
  end if;

  v_new_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_new_body), '\s+'), 1), 0);
  if length(trim(both from p_new_body)) = 0 then
    v_new_word_count := 0;
  end if;
  if v_new_word_count < 1 then
    raise exception 'empty_message';
  end if;

  select value into v_block_size from pricing_config where key = 'message_word_block_size';
  select value into v_base_credits from pricing_config where key = 'message_base_credits';
  select value into v_max_words from pricing_config where key = 'message_max_words';

  if v_new_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_new_word_count, v_max_words;
  end if;

  v_new_required_credits := (v_base_credits * greatest(ceil(v_new_word_count::numeric / v_block_size), 1))::bigint;
  if v_new_required_credits > v_message.credits_charged then
    raise exception 'edit_would_increase_cost: needs % credits, already charged %', v_new_required_credits, v_message.credits_charged;
  end if;

  update messages
  set body = p_new_body, word_count = v_new_word_count, edited_at = now()
  where id = p_message_id;

  return query select v_message.id, v_new_word_count, v_message.credits_charged, now();
end;
$$;

revoke execute on function public.fn_edit_message(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_edit_message(uuid, uuid, text) to service_role;
