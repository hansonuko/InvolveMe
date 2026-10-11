// GET /functions/v1/get-withdrawal-countdown
//
// Surfaces the caller's own auto-withdraw-sweep timing (fn_get_withdrawal_
// countdown, migration 20260916091500_fn_get_withdrawal_countdown.sql) so
// the wallet tab can render a real countdown ring instead of an invented
// one. Auth-gated like every other function here; no KYC tier requirement —
// a Tier-0 user asking this just gets the untrusted-tier numbers back, same
// as the sweep itself would treat them.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

interface FnGetWithdrawalCountdownRow {
  effective_sweep_hours: number;
  force_sweep_below_minimum: boolean;
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return errorResponse(405, 'method_not_allowed', 'Use GET.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('get-withdrawal-countdown: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  const db = serviceRoleClient();
  const { data: rawData, error } = await db
    .rpc('fn_get_withdrawal_countdown', { p_user_id: user.id })
    .single();

  if (error) {
    console.error('get-withdrawal-countdown: fn_get_withdrawal_countdown failed:', error.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const data = rawData as FnGetWithdrawalCountdownRow;

  return json(200, {
    effective_sweep_hours: data.effective_sweep_hours,
    force_sweep_below_minimum: data.force_sweep_below_minimum,
  });
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
