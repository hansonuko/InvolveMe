// POST /functions/v1/register-e2ee-device
//
// Real end-to-end encryption, step 2 (docs/21-E2EE-TECHNICAL-DESIGN.md §3)
// — wraps fn_register_e2ee_device. Called once per device the first time
// E2EE is set up on it. The client generates the actual keypairs (via
// react-native-libsodium) and sends only their PUBLIC halves plus an
// initial one-time-prekey batch — private key material never leaves the
// device (expo-secure-store), never reaches this function, never touches
// the request body at all. p_user_id is always the authenticated caller's
// own id, never taken from the request body — same identity-from-JWT
// posture every money/identity-sensitive function in this app already
// uses (_shared/auth.ts).
//
// No financial logic here (CLAUDE.md rule #1's scope doesn't strictly
// apply — this isn't money — but the "never trust the client with
// something identity-sensitive" spirit does).

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredBase64Key, requiredString } from '../_shared/validate.ts';

const ONE_TIME_PREKEY_MSG = 'one_time_prekeys must be a non-empty array of {key_id, public_key}.';

const RegisterE2eeDeviceRequestSchema = z.object({
  device_label: z.string().optional(),
  identity_key_ed25519: requiredBase64Key('identity_key_ed25519', 32),
  identity_key_x25519: requiredBase64Key('identity_key_x25519', 32),
  signed_prekey_id: z.number({
    required_error: 'signed_prekey_id is required.',
    invalid_type_error: 'signed_prekey_id is required.',
  }),
  signed_prekey_public: requiredBase64Key('signed_prekey_public', 32),
  signed_prekey_signature: requiredBase64Key('signed_prekey_signature', 64),
  signed_prekey_expires_at: requiredString('signed_prekey_expires_at'),
  one_time_prekeys: z
    .array(
      z.object({
        key_id: z.number(),
        public_key: requiredBase64Key('one_time_prekeys[].public_key', 32),
      }),
      { required_error: ONE_TIME_PREKEY_MSG, invalid_type_error: ONE_TIME_PREKEY_MSG },
    )
    .min(1, ONE_TIME_PREKEY_MSG),
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
    console.error('register-e2ee-device: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(RegisterE2eeDeviceRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { data: deviceId, error } = await db.rpc('fn_register_e2ee_device', {
    p_user_id: user.id,
    p_device_label: payload.device_label ?? null,
    p_identity_key_ed25519: payload.identity_key_ed25519,
    p_identity_key_x25519: payload.identity_key_x25519,
    p_signed_prekey_id: payload.signed_prekey_id,
    p_signed_prekey_public: payload.signed_prekey_public,
    p_signed_prekey_signature: payload.signed_prekey_signature,
    p_signed_prekey_expires_at: payload.signed_prekey_expires_at,
    p_one_time_prekeys: payload.one_time_prekeys,
  });

  if (error) {
    console.error('register-e2ee-device: fn_register_e2ee_device failed:', error.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { device_id: deviceId });
});
