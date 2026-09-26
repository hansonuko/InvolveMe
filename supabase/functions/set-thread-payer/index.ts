// POST /functions/v1/set-thread-payer
//
// Sets who pays for a thread — see migration 20260926140000_thread_payer_role.sql
// and docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §C1 for the schema/
// rationale. Same shape as set-thread-muted/set-thread-blocked (this file's
// closest siblings): the actual policy (self-only appointment, current-
// payer-only stepdown, the idle-conversation gate on taking over) lives
// entirely in fn_set_thread_payer, not here — this function only re-derives
// the caller's identity from their JWT (CLAUDE.md rule #1: no financial
// logic on the client, and "who's calling" is exactly the kind of thing a
// client-supplied field can't be trusted for) and maps DB errors to HTTP.
//
// `new_payer_id` is optional in the request body: omitting it (or passing
// null) means "step down." Passing the caller's own id means "take over."
// There is deliberately no way to name anyone else — fn_set_thread_payer
// enforces that server-side regardless, but rejecting it here too gives a
// clearer 400 instead of a raised exception for the obviously-wrong case.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';

// new_payer_id's *shape* (string, null, or absent) is validated here; the
// business rule that it may only ever equal the caller's own id is not a
// shape concern and stays below, since it depends on the authenticated
// user, not just the request body.
const SetThreadPayerRequestSchema = z.object({
  thread_id: requiredString('thread_id'),
  new_payer_id: z
    .string({ invalid_type_error: 'new_payer_id must be a string or null.' })
    .nullable()
    .optional(),
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
    console.error('set-thread-payer: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(SetThreadPayerRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const newPayerId = payload.new_payer_id ?? null;
  if (newPayerId !== null && newPayerId !== user.id) {
    return errorResponse(
      403,
      'can_only_appoint_self',
      'You can only set yourself as the payer, or step down.',
    );
  }

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_set_thread_payer', {
    p_thread_id: payload.thread_id,
    p_caller_id: user.id,
    p_new_payer_id: newPayerId,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('thread_not_found')) {
      return errorResponse(404, 'thread_not_found', 'No such thread.');
    }
    if (message.includes('not_a_participant')) {
      return errorResponse(403, 'not_a_participant', "You're not a participant in this thread.");
    }
    if (message.includes('can_only_appoint_self')) {
      return errorResponse(
        403,
        'can_only_appoint_self',
        'You can only set yourself as the payer, or step down.',
      );
    }
    if (message.includes('not_current_payer')) {
      return errorResponse(
        403,
        'not_current_payer',
        'Only the current payer can step down from paying.',
      );
    }
    if (message.includes('thread_not_idle_long_enough')) {
      return errorResponse(
        409,
        'thread_not_idle_long_enough',
        'This conversation needs to be quiet for a while before you can take over paying.',
      );
    }
    console.error('set-thread-payer: fn_set_thread_payer failed:', message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true, payer_id: newPayerId });
});
