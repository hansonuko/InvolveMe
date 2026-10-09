// POST /functions/v1/confirm-device-pairing
//
// docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 2. Called by the PHONE
// — already-authenticated, real session — after scanning the QR code and
// confirming "Link this device?" (the mobile scanner screen, Milestone
// 5). Wraps fn_confirm_device_pairing. Never called from a browser, so no
// CORS handling here, same as register-e2ee-device.
//
// p_user_id is always the authenticated caller's own id (CLAUDE.md rule
// #1's identity-from-JWT posture, same as every other identity-sensitive
// function in this app) — never taken from the request body.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredUuid } from '../_shared/validate.ts';

const ConfirmPairingRequestSchema = z.object({
  pairing_id: requiredUuid('pairing_id'),
  platform: z.string().max(100).optional(),
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

function mapConfirmPairingError(pgMessage: string): Response {
  if (pgMessage.startsWith('pairing_not_found')) {
    return errorResponse(404, 'pairing_not_found', 'That QR code was not recognized.');
  }
  if (pgMessage.startsWith('pairing_expired')) {
    return errorResponse(400, 'pairing_expired', 'That QR code has expired — generate a new one.');
  }
  if (pgMessage.startsWith('pairing_already_confirmed')) {
    return errorResponse(409, 'pairing_already_confirmed', 'That QR code has already been used.');
  }
  if (pgMessage.startsWith('max_linked_devices_reached')) {
    return errorResponse(
      400,
      'max_linked_devices_reached',
      'You already have the maximum number of linked devices. Remove one before linking another.',
    );
  }
  console.error('confirm-device-pairing: unmapped fn_confirm_device_pairing error:', pgMessage);
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
    console.error('confirm-device-pairing: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(ConfirmPairingRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const { pairing_id, platform } = parsed.data;

  const db = serviceRoleClient();
  const { data: linkedDeviceId, error } = await db.rpc('fn_confirm_device_pairing', {
    p_pairing_id: pairing_id,
    p_user_id: user.id,
    p_platform: platform ?? null,
  });

  if (error) return mapConfirmPairingError(error.message);

  return json(200, { linked_device_id: linkedDeviceId });
});
