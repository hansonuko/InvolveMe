// POST /functions/v1/set-thread-muted
//
// Sets the caller's own mute flag on a thread — see migration
// 20260917110000_thread_mute.sql for the schema/rationale. Same shape as
// set-thread-blocked (this file is deliberately its closest sibling), but
// simpler: either participant can mute/unmute independently, with no
// "only the blocker can unblock" precedence rule to enforce.
//
// No financial logic — the same "identity re-derived from the caller's
// JWT" posture as every other function here, via _shared/auth.ts.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredBoolean, requiredString } from '../_shared/validate.ts';

const SetThreadMutedRequestSchema = z.object({
  thread_id: requiredString('thread_id'),
  muted: requiredBoolean('muted'),
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
    console.error('set-thread-muted: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(SetThreadMutedRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_set_thread_muted', {
    p_thread_id: payload.thread_id,
    p_caller_id: user.id,
    p_muted: payload.muted,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('thread_not_found')) {
      return errorResponse(404, 'thread_not_found', 'No such thread.');
    }
    if (message.includes('not_a_participant')) {
      return errorResponse(403, 'not_a_participant', "You're not a participant in this thread.");
    }
    console.error('set-thread-muted: fn_set_thread_muted failed:', message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true, muted: payload.muted });
});
