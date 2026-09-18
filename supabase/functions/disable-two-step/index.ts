// POST /functions/v1/disable-two-step
//
// Turns off two-step verification — requires the current PIN, same
// lockout-protected check set-two-step-pin uses when changing one, for
// the same reason: without it, anyone holding a valid session could
// silently disable an account's 2FA with no verification at all.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadTwoStepPinPepper } from '../_shared/two-step-config.ts';
import {
  currentlyLockedUntil,
  fieldsAfterFailedAttempt,
  hashPin,
  isValidPinFormat,
} from '../_shared/twoStep.ts';

interface DisableTwoStepRequestBody {
  current_pin?: string;
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
    console.error('disable-two-step: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: DisableTwoStepRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const pepper = loadTwoStepPinPepper();
  if (!pepper) {
    console.error('disable-two-step: TWO_STEP_PIN_PEPPER is not configured.');
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const db = serviceRoleClient();
  const { data: row, error: rowError } = await db
    .from('users')
    .select('two_step_enabled, two_step_pin_hash, two_step_failed_attempts, two_step_locked_until')
    .eq('id', user.id)
    .single();
  if (rowError || !row) {
    console.error('disable-two-step: could not load user row:', rowError?.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  if (!row.two_step_enabled) {
    return errorResponse(400, 'not_enabled', 'Two-step verification is not currently on.');
  }

  const lockedUntil = currentlyLockedUntil(row);
  if (lockedUntil) {
    return json(429, {
      error: 'too_many_attempts',
      message: 'Too many incorrect attempts. Try again later.',
      locked_until: lockedUntil,
    });
  }

  if (!isValidPinFormat(payload.current_pin)) {
    return errorResponse(400, 'invalid_request', 'current_pin is required.');
  }

  const currentHash = await hashPin(payload.current_pin, pepper);
  if (currentHash !== row.two_step_pin_hash) {
    const failed = fieldsAfterFailedAttempt(row.two_step_failed_attempts);
    await db.from('users').update(failed).eq('id', user.id);
    return errorResponse(403, 'incorrect_pin', 'That PIN is incorrect.');
  }

  const { error: updateError } = await db
    .from('users')
    .update({
      two_step_enabled: false,
      two_step_pin_hash: null,
      two_step_recovery_email: null,
      two_step_reset_requested_at: null,
      two_step_failed_attempts: 0,
      two_step_locked_until: null,
    })
    .eq('id', user.id);
  if (updateError) {
    console.error('disable-two-step: update failed:', updateError.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true });
});
