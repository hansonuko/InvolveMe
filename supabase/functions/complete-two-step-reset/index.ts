// POST /functions/v1/complete-two-step-reset
//
// Finishes the forgotten-PIN cooldown started by request-two-step-reset:
// re-checks server-side (never trusts a client-computed "the cooldown is
// over" claim) that TWO_STEP_RESET_COOLDOWN_DAYS has genuinely elapsed
// since the reset was requested, and only then clears two-step
// verification entirely — same effect as disable-two-step, reached via
// the cooldown instead of the current PIN.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { TWO_STEP_RESET_COOLDOWN_DAYS } from '../_shared/twoStep.ts';

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
    console.error('complete-two-step-reset: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  const db = serviceRoleClient();
  const { data: row, error: rowError } = await db
    .from('users')
    .select('two_step_enabled, two_step_reset_requested_at')
    .eq('id', user.id)
    .single();
  if (rowError || !row) {
    console.error('complete-two-step-reset: could not load user row:', rowError?.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  if (!row.two_step_enabled) {
    return errorResponse(400, 'not_enabled', 'Two-step verification is not on for this account.');
  }
  if (!row.two_step_reset_requested_at) {
    return errorResponse(400, 'no_reset_requested', 'No reset is in progress.');
  }

  const availableAt =
    new Date(row.two_step_reset_requested_at).getTime() +
    TWO_STEP_RESET_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  if (Date.now() < availableAt) {
    return json(403, {
      error: 'cooldown_not_elapsed',
      message: 'The reset cooldown has not finished yet.',
      available_at: new Date(availableAt).toISOString(),
    });
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
    console.error('complete-two-step-reset: update failed:', updateError.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true });
});
