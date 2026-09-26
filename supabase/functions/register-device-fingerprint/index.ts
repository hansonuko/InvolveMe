// POST /functions/v1/register-device-fingerprint
//
// Links the caller's device to their account for collusion detection
// (docs/06-SECURITY-FRAUD-LOOPHOLES.md §2) — see
// supabase/migrations/20260915090000_device_fingerprinting.sql's header
// for why this needed its own table/function rather than a client-writable
// column. Same posture as every other function here that touches a
// trust-relevant column no user should be able to spoof: identity comes
// from the caller's own JWT (_shared/auth.ts), never trusted from the
// request body, and the actual write goes through a SECURITY DEFINER
// function this Edge Function is the only caller of.
//
// The fingerprint hash itself is computed and hashed client-side (see
// apps/mobile/lib/deviceFingerprint.ts) — this function never sees a raw
// hardware identifier, only its SHA-256, same "hash before it reaches the
// server" posture KYC_HASH_PEPPER already establishes for BVN/NIN.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody } from '../_shared/validate.ts';

const FINGERPRINT_MSG = 'fingerprint_hash must be a 64-character hex SHA-256 digest.';
const RegisterDeviceFingerprintRequestSchema = z.object({
  fingerprint_hash: z
    .string({ required_error: FINGERPRINT_MSG, invalid_type_error: FINGERPRINT_MSG })
    .regex(/^[0-9a-f]{64}$/i, FINGERPRINT_MSG),
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
    console.error('register-device-fingerprint: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(RegisterDeviceFingerprintRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_link_device_fingerprint', {
    p_user_id: user.id,
    p_fingerprint_hash: payload.fingerprint_hash.toLowerCase(),
  });

  if (error) {
    console.error('register-device-fingerprint: fn_link_device_fingerprint failed:', error.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true });
});
