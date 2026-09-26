// POST /functions/v1/set-thread-blocked
//
// The actual write half of blocking — threads.blocked_by and its
// enforcement in fn_send_message already existed before this session
// (as `is_blocked`), but nothing anywhere ever set it. See migration
// 20260914090000_settings_privacy_reports_push.sql for the schema and
// why it's `blocked_by` (who blocked it) rather than a plain boolean.
//
// No financial logic — not a CLAUDE.md rule #1 concern — but the same
// "identity re-derived from the caller's JWT" posture as every other
// function here, via _shared/auth.ts.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredBoolean, requiredString } from '../_shared/validate.ts';

const SetThreadBlockedRequestSchema = z.object({
  thread_id: requiredString('thread_id'),
  blocked: requiredBoolean('blocked'),
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
    console.error('set-thread-blocked: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(SetThreadBlockedRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_set_thread_blocked', {
    p_thread_id: payload.thread_id,
    p_caller_id: user.id,
    p_blocked: payload.blocked,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('thread_not_found')) {
      return errorResponse(404, 'thread_not_found', 'No such thread.');
    }
    if (message.includes('not_a_participant')) {
      return errorResponse(403, 'not_a_participant', "You're not a participant in this thread.");
    }
    if (message.includes('not_the_blocker')) {
      return errorResponse(
        403,
        'not_the_blocker',
        'Only the person who blocked this thread can unblock it.',
      );
    }
    console.error('set-thread-blocked: fn_set_thread_blocked failed:', message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true, blocked: payload.blocked });
});
