// POST /functions/v1/delete-message-for-everyone
//
// Wraps fn_delete_message_for_everyone (migration 20260919140000_message_
// delete.sql, extended by 20260925120000_chat_media_pipeline.sql for chat
// media) — sender-only, within the delete window. No financial logic here
// (CLAUDE.md rule #1): the credits/escrow/ledger trail is completely
// untouched either way, this only ever overwrites `messages.body`/
// media_path/media_type and flips `deleted_for_everyone`. p_sender_id is
// always the authenticated caller's own id.
//
// fn_delete_message_for_everyone now returns the media_path it just
// cleared (or null) so this function can remove the real Storage object —
// same "before/instead of relying on RLS afterward" posture
// useDeleteStatus's own comment documents for the status pipeline, except
// here it's naturally *after* the DB row is already updated (this runs as
// service_role, which bypasses chat_media_delete_own's RLS entirely, so
// there's no ordering hazard the way there is for a client-side delete
// subject to RLS). A Storage failure here is logged, not surfaced as a
// user-facing error — the message is genuinely deleted either way; a
// leftover orphaned blob is the acceptable failure mode, matching this
// session's own expire-statuses function's posture for the same class of
// problem.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface DeleteMessageForEveryoneRequestBody {
  message_id?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

function mapError(pgMessage: string): Response {
  if (pgMessage.startsWith('message_not_found')) {
    return errorResponse(404, 'message_not_found', 'Message does not exist.');
  }
  if (pgMessage.startsWith('not_the_sender')) {
    return errorResponse(
      403,
      'not_the_sender',
      'You can only delete your own messages for everyone.',
    );
  }
  if (pgMessage.startsWith('already_deleted')) {
    return errorResponse(409, 'already_deleted', 'This message was already deleted.');
  }
  if (pgMessage.startsWith('delete_window_expired')) {
    return errorResponse(
      409,
      'delete_window_expired',
      'The time window for deleting this message for everyone has passed.',
    );
  }

  console.error('delete-message-for-everyone: unmapped DB error:', pgMessage);
  return errorResponse(500, 'internal_error', 'Something went wrong.');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('delete-message-for-everyone: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: DeleteMessageForEveryoneRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.message_id !== 'string' || !UUID_RE.test(payload.message_id)) {
    return errorResponse(400, 'invalid_request', 'message_id must be a UUID.');
  }

  const db = serviceRoleClient();
  const { data: clearedMediaPath, error } = await db.rpc('fn_delete_message_for_everyone', {
    p_message_id: payload.message_id,
    p_sender_id: user.id,
  });

  if (error) {
    return mapError(error.message);
  }

  if (clearedMediaPath) {
    const { error: storageError } = await db.storage
      .from('chat-media')
      .remove([clearedMediaPath as string]);
    if (storageError) {
      console.error('delete-message-for-everyone: storage removal failed:', storageError.message);
    }
  }

  return json(200, { ok: true });
});
