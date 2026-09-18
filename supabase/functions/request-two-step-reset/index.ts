// POST /functions/v1/request-two-step-reset
//
// Starts the forgotten-PIN cooldown ("Forgot PIN?" on the login-time
// two-step gate). Deliberately does NOT clear two-step verification
// itself — that only happens once the cooldown has genuinely elapsed,
// checked server-side by complete-two-step-reset. See the migration's own
// header comment for why an instant OTP-based bypass was considered and
// rejected: reaching this endpoint at all already required OTP access,
// which is exactly the factor two-step verification exists to add a
// second layer on top of.
//
// Idempotent: calling this again while a request is already pending
// doesn't push the clock back out — the cooldown starts once, from the
// first request, not from whichever attempt happens to be most recent.

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
    console.error('request-two-step-reset: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  const db = serviceRoleClient();
  const { data: row, error: rowError } = await db
    .from('users')
    .select('two_step_enabled, two_step_reset_requested_at')
    .eq('id', user.id)
    .single();
  if (rowError || !row) {
    console.error('request-two-step-reset: could not load user row:', rowError?.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  if (!row.two_step_enabled) {
    return errorResponse(400, 'not_enabled', 'Two-step verification is not on for this account.');
  }

  const requestedAt = row.two_step_reset_requested_at ?? new Date().toISOString();
  if (!row.two_step_reset_requested_at) {
    const { error: updateError } = await db
      .from('users')
      .update({ two_step_reset_requested_at: requestedAt })
      .eq('id', user.id);
    if (updateError) {
      console.error('request-two-step-reset: update failed:', updateError.message);
      return errorResponse(500, 'internal_error', 'Something went wrong.');
    }
  }

  const availableAt = new Date(
    new Date(requestedAt).getTime() + TWO_STEP_RESET_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  return json(200, { requested_at: requestedAt, available_at: availableAt });
});
