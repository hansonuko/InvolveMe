// POST /functions/v1/mark-thread-read
//
// Sets the caller's own read cursor on a thread (see migration
// 20260914080000_thread_read_cursor.sql for the schema/rationale). No
// financial logic — this doesn't need docs/03-ECONOMY-LEDGER.md's
// scrutiny, but it does follow the same "identity is re-derived from the
// caller's JWT, never trusted from the request body" posture every other
// function here uses, via _shared/auth.ts.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';

const MarkThreadReadRequestSchema = z.object({
  thread_id: requiredString('thread_id'),
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('mark-thread-read: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(MarkThreadReadRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_mark_thread_read', {
    p_thread_id: payload.thread_id,
    p_caller_id: user.id,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('thread_not_found')) {
      return errorResponse(404, 'thread_not_found', 'No such thread.');
    }
    if (message.includes('not_a_participant')) {
      return errorResponse(403, 'not_a_participant', "You're not a participant in this thread.");
    }
    console.error('mark-thread-read: fn_mark_thread_read failed:', message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true });
});
