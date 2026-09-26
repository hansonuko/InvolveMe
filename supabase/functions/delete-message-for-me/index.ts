// POST /functions/v1/delete-message-for-me
//
// Wraps fn_delete_message_for_me (migration 20260919140000_message_delete.sql)
// — a per-viewer visibility hide, available to either thread participant on
// any message, any age/status. No financial logic here (CLAUDE.md rule
// #1); p_user_id is always the authenticated caller's own id.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredUuid } from '../_shared/validate.ts';

const DeleteMessageForMeRequestSchema = z.object({
  message_id: requiredUuid('message_id'),
});

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
  if (pgMessage.startsWith('not_a_participant')) {
    return errorResponse(403, 'not_a_participant', 'You are not part of this conversation.');
  }

  console.error('delete-message-for-me: unmapped DB error:', pgMessage);
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
    console.error('delete-message-for-me: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(DeleteMessageForMeRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_delete_message_for_me', {
    p_message_id: payload.message_id,
    p_user_id: user.id,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { ok: true });
});
