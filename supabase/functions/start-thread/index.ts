// POST /functions/v1/start-thread
//
// Resolves (or creates) the thread between the caller and another user,
// without sending a message — for the "tap a found user, go straight into
// their chat" flow (docs/10-UX-REFINEMENT-BACKLOG.md Batch B, B3). Before
// this, the only way to create a thread was `send-message`'s own internal
// `fn_start_thread` call, which required typing and sending a real first
// message. `fn_start_thread` itself does no financial logic and is
// idempotent (find-or-create), so exposing it directly here is the same
// class of change as `mark-thread-read`/`set-thread-blocked` — small,
// non-money, single-purpose. The caller is always the payer (participant_a)
// for a brand-new thread, same as send-message's own recipient_id path —
// whoever initiates a new conversation pays for it.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

const StartThreadRequestSchema = z.object({
  recipient_id: requiredString('recipient_id'),
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

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('start-thread: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(StartThreadRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { data: threadId, error } = await db.rpc('fn_start_thread', {
    p_payer_id: user.id,
    p_payee_id: payload.recipient_id,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('cannot_thread_with_self')) {
      return errorResponse(
        400,
        'cannot_thread_with_self',
        "You can't start a thread with yourself.",
      );
    }
    console.error('start-thread: fn_start_thread failed:', message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { thread_id: threadId });
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const res = await handleRequest(req);
  const extra = corsHeaders(req);
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});
