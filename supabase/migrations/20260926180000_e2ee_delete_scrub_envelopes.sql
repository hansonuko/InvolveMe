-- E2EE residual gap #1 (docs/00-SESSION-HANDOFF.md session 35 "Next
-- session" list, item 1): fn_delete_message_for_everyone blanks
-- messages.body/media_path/media_type/audio fields but never touched
-- e2ee_message_envelopes — the actual ciphertext for an 'active'-thread
-- message lives entirely in that table, not in `messages.body` (which is
-- already null for those messages, docs/21 §2/§3). A party who hadn't yet
-- fetched/decrypted a specific envelope before the sender "deleted for
-- everyone" could still fetch and decrypt it afterward — the real privacy
-- gap flagged at the end of session 35, fixed here first per that list's
-- own risk ordering.
--
-- Unconditional delete, not gated on e2ee_status: a plaintext ('off')
-- thread's messages never have envelope rows in the first place (nothing
-- to write, docs/21 §3's "completely unchanged" plaintext path), so this
-- is a no-op there — no need to branch on thread state to stay correct,
-- same "let it fall out of the data instead of an explicit if" posture
-- docs/21 §3 already used for fn_release_escrow's duplicate-content skip.
--
-- Deliberately still not gated on any per-recipient "already delivered/
-- decrypted" state — there isn't one to check (Double Ratchet has no
-- server-visible decrypted/undecrypted flag by design, docs/21 §1) — so
-- this scrubs every envelope for the message, sender's and every
-- recipient device's copy alike, matching the tombstone's own "genuinely
-- not recoverable through the app afterward" posture
-- (20260919140000_message_delete.sql's header comment) applied to
-- ciphertext instead of plaintext.
--
-- Signature/return type unchanged (still returns the cleared media_path,
-- text) -> create-or-replace, not drop+create, same as the
-- 20260926110000 audio-fields extension.

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

  delete from e2ee_message_envelopes where message_id = p_message_id;

  return v_message.media_path;
end;
$$;

revoke execute on function public.fn_delete_message_for_everyone(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_delete_message_for_everyone(uuid, uuid) to service_role;
