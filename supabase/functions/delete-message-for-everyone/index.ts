// POST /functions/v1/delete-message-for-everyone
//
// Wraps fn_delete_message_for_everyone (migration 20260919140000_message_
// delete.sql) — sender-only, within the delete window. No financial logic
// here (CLAUDE.md rule #1): the credits/escrow/ledger trail is completely
// untouched either way, this only ever overwrites `messages.body` and
// flips `deleted_for_everyone`. p_sender_id is always the authenticated
// caller's own id.

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
  const { error } = await db.rpc('fn_delete_message_for_everyone', {
    p_message_id: payload.message_id,
    p_sender_id: user.id,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { ok: true });
});
