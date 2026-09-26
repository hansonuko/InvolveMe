// POST /functions/v1/enable-e2ee
//
// Real end-to-end encryption, step 2 (docs/21-E2EE-TECHNICAL-DESIGN.md §3)
// — wraps fn_enable_e2ee. Flips a thread's e2ee_status to 'active'.
// fn_enable_e2ee itself is the actual authority (participant-only, both
// sides must already have a registered device, idempotent) — this
// function only re-derives the caller's identity from their JWT and maps
// DB errors to HTTP, same posture every other thread-state function here
// (set-thread-muted, set-thread-blocked, set-thread-payer) already uses.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredUuid } from '../_shared/validate.ts';

const EnableE2eeRequestSchema = z.object({
  thread_id: requiredUuid('thread_id'),
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

function mapEnableE2eeError(pgMessage: string): Response {
  if (pgMessage.startsWith('thread_not_found')) {
    return errorResponse(404, 'thread_not_found', 'No such thread.');
  }
  if (pgMessage.startsWith('not_a_participant')) {
    return errorResponse(403, 'not_a_participant', "You're not a participant in this thread.");
  }
  if (
    pgMessage.startsWith('participant_a_has_no_e2ee_device') ||
    pgMessage.startsWith('participant_b_has_no_e2ee_device')
  ) {
    return errorResponse(
      409,
      'partner_not_ready',
      'Both people need to set up encryption on their device before this conversation can be protected.',
    );
  }
  console.error('enable-e2ee: unmapped DB error:', pgMessage);
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
    console.error('enable-e2ee: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(EnableE2eeRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_enable_e2ee', {
    p_thread_id: payload.thread_id,
    p_caller_id: user.id,
  });

  if (error) {
    return mapEnableE2eeError(error.message);
  }

  return json(200, { ok: true });
});
