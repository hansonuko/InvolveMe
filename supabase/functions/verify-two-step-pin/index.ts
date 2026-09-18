// POST /functions/v1/verify-two-step-pin
//
// The login-time gate: called from the mobile app's two-step screen right
// after a fresh phone+OTP sign-in, before the auth gate (app/_layout.tsx)
// lets the session into the app. A wrong PIN counts toward the same
// lockout set-two-step-pin/disable-two-step already enforce; a right one
// clears it and also clears any pending forgot-PIN reset request (see
// request-two-step-reset) — reaching the correct PIN moots a cooldown that
// only exists because the PIN was forgotten.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadTwoStepPinPepper } from '../_shared/two-step-config.ts';
import {
  currentlyLockedUntil,
  fieldsAfterFailedAttempt,
  fieldsAfterSuccess,
  hashPin,
  isValidPinFormat,
} from '../_shared/twoStep.ts';

interface VerifyTwoStepPinRequestBody {
  pin?: string;
}

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
    console.error('verify-two-step-pin: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: VerifyTwoStepPinRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (!isValidPinFormat(payload.pin)) {
    return errorResponse(400, 'invalid_pin', 'pin must be exactly 6 digits.');
  }

  const pepper = loadTwoStepPinPepper();
  if (!pepper) {
    console.error('verify-two-step-pin: TWO_STEP_PIN_PEPPER is not configured.');
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const db = serviceRoleClient();
  const { data: row, error: rowError } = await db
    .from('users')
    .select('two_step_enabled, two_step_pin_hash, two_step_failed_attempts, two_step_locked_until')
    .eq('id', user.id)
    .single();
  if (rowError || !row) {
    console.error('verify-two-step-pin: could not load user row:', rowError?.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  if (!row.two_step_enabled) {
    // Nothing to verify against — the client shouldn't have shown this
    // screen at all, but fail closed with a clear code rather than a
    // generic 500 if it somehow did.
    return errorResponse(400, 'not_enabled', 'Two-step verification is not on for this account.');
  }

  const lockedUntil = currentlyLockedUntil(row);
  if (lockedUntil) {
    return json(429, {
      error: 'too_many_attempts',
      message: 'Too many incorrect attempts. Try again later.',
      locked_until: lockedUntil,
    });
  }

  const candidateHash = await hashPin(payload.pin, pepper);
  if (candidateHash !== row.two_step_pin_hash) {
    const failed = fieldsAfterFailedAttempt(row.two_step_failed_attempts);
    await db.from('users').update(failed).eq('id', user.id);
    return json(200, {
      verified: false,
      // This attempt is what triggered the lockout, if it did — surfaced
      // so the client can show the lockout message immediately instead of
      // waiting for a separate 429 on the next attempt.
      locked_until: failed.two_step_locked_until,
    });
  }

  await db
    .from('users')
    .update({ ...fieldsAfterSuccess, two_step_reset_requested_at: null })
    .eq('id', user.id);

  return json(200, { verified: true });
});
