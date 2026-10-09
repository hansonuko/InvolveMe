// POST /functions/v1/revoke-linked-device
//
// docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 2. Backs the mobile
// "Linked Devices" settings screen's per-device revoke and "log out of
// all other devices" bulk action (Milestone 5) — wraps
// fn_revoke_linked_device. `linked_device_id` omitted/null means "revoke
// every active linked device for this user," matching the RPC's own
// contract (see its migration's header comment for why this is one
// function, not two).

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody } from '../_shared/validate.ts';

const RevokeRequestSchema = z.object({
  linked_device_id: z.string().uuid('linked_device_id must be a valid UUID.').optional(),
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
    console.error('revoke-linked-device: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(RevokeRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const { linked_device_id } = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_revoke_linked_device', {
    p_user_id: user.id,
    p_linked_device_id: linked_device_id ?? null,
  });

  if (error) {
    console.error('revoke-linked-device: fn_revoke_linked_device failed:', error.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true });
});
