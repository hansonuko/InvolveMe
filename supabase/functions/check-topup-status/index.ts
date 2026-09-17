// POST /functions/v1/check-topup-status
//
// The "instant" front-line for buy-credit's payment-pending screen
// (docs/00-SESSION-HANDOFF.md session 12, continued — user feedback: the
// reconcile-topups cron closed the "stuck forever" bug, but its 5-minute
// age gate + 10-minute schedule meant a user actively watching the payment
// screen could still wait up to ~15 minutes for anything to happen. Not
// "instant" once webhook delivery can't be trusted — see
// reconcile-topups' own header for why it can't be trusted).
//
// Same checkCollectionStatus ground-truth check reconcile-topups uses, but
// called on demand, for one specific topup, with no age gate — the mobile
// app polls this every few seconds while the buy-credit modal is open and
// still pending, instead of only waiting on a DB row that nothing updates
// quickly. reconcile-topups remains the safety net for a user who
// backgrounds the app or closes the modal before this ever gets a chance
// to run; this is the fast path for the user who's still looking at the
// screen.
//
// Auth: a normal user JWT (requireAuthenticatedUser, verify_jwt stays
// default ON) — unlike reconcile-topups, this has a real per-user caller,
// so it uses the same identity posture as every other user-facing function
// here. Ownership-checked explicitly (topup.user_id === caller.id), not
// just auth-checked: without that, any authenticated user could poll any
// topup_id and spend this app's Flutterwave API quota probing other
// people's payments.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import { notifyTopupConfirmed, runInBackground } from '../_shared/push.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

interface CheckTopupStatusRequestBody {
  topup_id?: string;
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
    console.error('check-topup-status: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: CheckTopupStatusRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.topup_id !== 'string' || payload.topup_id.trim().length === 0) {
    return errorResponse(400, 'invalid_request', 'topup_id is required.');
  }

  const db = serviceRoleClient();
  const { data: topup, error: fetchError } = await db
    .from('topups')
    .select('id, user_id, status, provider')
    .eq('id', payload.topup_id)
    .single();

  if (fetchError || !topup) {
    return errorResponse(404, 'topup_not_found', 'No such topup.');
  }
  if (topup.user_id !== user.id) {
    return errorResponse(403, 'not_your_topup', "This topup doesn't belong to you.");
  }

  // Already resolved (by the webhook, if it ever works, or by the cron, or
  // by a previous call to this same endpoint) — short-circuit before ever
  // touching Flutterwave. Keeps a client polling every few seconds from
  // burning an external API call once there's nothing left to check.
  if (topup.status !== 'pending') {
    return json(200, { status: topup.status });
  }
  if (topup.provider !== 'flutterwave') {
    // Nothing to check against for a provider this function doesn't know
    // how to ask — report the true DB status rather than guess.
    return json(200, { status: topup.status });
  }

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());
  try {
    const result = await provider.checkCollectionStatus(topup.id);
    if (result.status === 'succeeded' && result.providerChargeId) {
      const { error: confirmError } = await db.rpc('fn_confirm_topup', {
        p_topup_id: topup.id,
        p_provider_ref: result.providerChargeId,
      });
      if (confirmError) {
        console.error(
          `check-topup-status: fn_confirm_topup(${topup.id}) failed:`,
          confirmError.message,
        );
        // Don't surface the internal error to the client mid-poll — it'll
        // just try again next tick, and reconcile-topups' cron is still
        // there as a backstop regardless.
        return json(200, { status: 'pending' });
      }
      runInBackground(() => notifyTopupConfirmed(db, topup.id));
      return json(200, { status: 'completed' });
    }
    // 'failed' isn't flipped here either, same posture as reconcile-topups
    // — not this endpoint's job to own that state transition. Report the
    // real (still pending) DB status; a still-pending topup against a
    // charge Flutterwave says failed will simply never resolve to
    // 'completed', which is the correct outcome even though nothing here
    // tells the user that explicitly yet.
    return json(200, { status: 'pending' });
  } catch (e) {
    console.error(`check-topup-status: checkCollectionStatus(${topup.id}) threw:`, e);
    // A transient Flutterwave-side error shouldn't break the client's
    // poll loop — it just tries again on the next tick.
    return json(200, { status: 'pending' });
  }
});
