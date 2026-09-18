// POST /functions/v1/set-two-step-pin
//
// Sets or changes the caller's two-step-verification PIN. First-time setup
// (two_step_enabled currently false) needs only the new pin; changing an
// already-set PIN requires current_pin too, verified against the stored
// hash before anything is overwritten — otherwise anyone holding a valid
// session could silently take over 2FA on an account that already has it
// turned on, which is worse than not having the feature at all.
//
// recovery_email is captured but not wired to any email-sending capability
// (this app has none — see the migration's header comment); it exists so
// the field has somewhere to live once that infra decision is made, not
// because anything reads it yet.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadTwoStepPinPepper } from '../_shared/two-step-config.ts';
import {
  currentlyLockedUntil,
  fieldsAfterFailedAttempt,
  fieldsAfterSuccess,
  hashPin,
  isValidPinFormat,
} from '../_shared/twoStep.ts';

interface SetTwoStepPinRequestBody {
  pin?: string;
  current_pin?: string;
  recovery_email?: string;
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('set-two-step-pin: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: SetTwoStepPinRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (!isValidPinFormat(payload.pin)) {
    return errorResponse(400, 'invalid_pin', 'pin must be exactly 6 digits.');
  }
  if (payload.recovery_email !== undefined && payload.recovery_email !== '') {
    if (typeof payload.recovery_email !== 'string' || !EMAIL_RE.test(payload.recovery_email)) {
      return errorResponse(400, 'invalid_request', 'recovery_email is not a valid email address.');
    }
  }

  const pepper = loadTwoStepPinPepper();
  if (!pepper) {
    console.error('set-two-step-pin: TWO_STEP_PIN_PEPPER is not configured.');
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const db = serviceRoleClient();
  const { data: row, error: rowError } = await db
    .from('users')
    .select('two_step_enabled, two_step_pin_hash, two_step_failed_attempts, two_step_locked_until')
    .eq('id', user.id)
    .single();
  if (rowError || !row) {
    console.error('set-two-step-pin: could not load user row:', rowError?.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  if (row.two_step_enabled) {
    // Changing an existing PIN needs the current one, and is subject to
    // the exact same lockout as logging in with it — otherwise "change
    // PIN" would be a second, unprotected door into brute-forcing it.
    const lockedUntil = currentlyLockedUntil(row);
    if (lockedUntil) {
      return json(429, {
        error: 'too_many_attempts',
        message: 'Too many incorrect attempts. Try again later.',
        locked_until: lockedUntil,
      });
    }

    if (!isValidPinFormat(payload.current_pin)) {
      return errorResponse(
        400,
        'invalid_request',
        'current_pin is required to change an existing PIN.',
      );
    }

    const currentHash = await hashPin(payload.current_pin, pepper);
    if (currentHash !== row.two_step_pin_hash) {
      const failed = fieldsAfterFailedAttempt(row.two_step_failed_attempts);
      await db.from('users').update(failed).eq('id', user.id);
      return errorResponse(403, 'incorrect_pin', 'That PIN is incorrect.');
    }
  }

  const newHash = await hashPin(payload.pin, pepper);

  const { error: updateError } = await db
    .from('users')
    .update({
      two_step_enabled: true,
      two_step_pin_hash: newHash,
      two_step_recovery_email: payload.recovery_email || null,
      two_step_reset_requested_at: null, // a pending forgot-PIN cooldown is moot once a PIN is actively (re)set
      ...fieldsAfterSuccess,
    })
    .eq('id', user.id);
  if (updateError) {
    console.error('set-two-step-pin: update failed:', updateError.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true });
});
