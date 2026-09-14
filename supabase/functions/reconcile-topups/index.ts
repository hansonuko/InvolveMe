// POST /functions/v1/reconcile-topups
//
// Server-to-server only, triggered by pg_cron via pg_net (see migration
// 20260914120000_reconcile_topups_cron.sql) — not called by the app, and
// never by Flutterwave either (that's webhook-flutterwave's job).
//
// WHY THIS EXISTS (docs/00-SESSION-HANDOFF.md session 12): webhook-flutterwave
// had already been "permanently fixed" twice — first the platform JWT-gate
// blocking it entirely, then the verif-hash/tx_ref contract rewrite — and
// the credit-not-landing bug recurred anyway. Root-caused this time with
// real ground truth, not another docs re-read: `webhook_events_seen` has
// NEVER received a single real Flutterwave-initiated row, ever. Every
// "completed" topup in this app's history was reconciled by hand. That
// means the gap isn't a payload-parsing bug in this codebase at all — it's
// that Flutterwave has never once successfully delivered a webhook here,
// almost certainly a dashboard-side webhook URL/secret misconfiguration
// that nothing in this codebase can see or fix (v4's API exposes no way to
// read that config back). Waiting on a dashboard fix to "hold" a second
// time, with no independent verification, is exactly the failure mode that
// let this go unnoticed for weeks the first time.
//
// So: this function doesn't trust the webhook to ever arrive. It's a
// pull-based safety net — checkCollectionStatus asks Flutterwave directly,
// the same ground truth this incident was actually diagnosed from. The
// webhook (when it works) is the fast path; this is the guarantee.
// Idempotent by construction: fn_confirm_topup no-ops on an
// already-completed topup, and this only ever acts on topups still
// `pending`.
//
// Auth: MUST be deployed with `--no-verify-jwt`, same as webhook-flutterwave
// and for the same structural reason — pg_net's http_post has no clean way
// to attach a real Supabase-signed JWT without embedding a live secret
// (the service role key) directly in a git-committed migration, which this
// project never does for any other credential either. Relying on the
// platform gateway here would also reintroduce the exact failure mode that
// broke webhook-flutterwave the first time (silently rejected before this
// file's own code ever runs) — deliberately not repeating that mistake.
// Authorization instead comes from a shared `X-Cron-Secret` header, checked
// below with the same constant-time-compare posture as verifyWebhook.
// CRON_INTERNAL_SECRET is a function secret (`supabase secrets set`), never
// committed to git, mirrored as a `current_setting` on the DB side (see the
// migration) for the cron job to send.

import { timingSafeEqual } from 'node:crypto';
import { serviceRoleClient } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkCronSecret(req: Request): boolean {
  const expected = Deno.env.get('CRON_INTERNAL_SECRET') ?? '';
  const actual = req.headers.get('x-cron-secret') ?? '';
  if (!expected || !actual) return false;
  const expectedBuf = new TextEncoder().encode(expected);
  const actualBuf = new TextEncoder().encode(actual);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

// Only ever acts on topups old enough that a legitimately-in-flight
// transfer (or a webhook that's about to land normally) isn't raced —
// matches webhook-flutterwave's own reference-implementation timing rather
// than guessing a new number.
const MIN_AGE_MINUTES = 5;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed', message: 'Use POST.' });
  }
  if (!checkCronSecret(req)) {
    return json(401, { error: 'unauthorized', message: 'Invalid or missing X-Cron-Secret.' });
  }

  const db = serviceRoleClient();
  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());

  const cutoff = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000).toISOString();
  const { data: stuckTopups, error: queryError } = await db
    .from('topups')
    .select('id, provider')
    .eq('status', 'pending')
    .eq('provider', 'flutterwave')
    .lt('created_at', cutoff)
    .limit(50); // one run per cron tick shouldn't unboundedly grow — see note below

  if (queryError) {
    console.error('reconcile-topups: could not query stuck topups:', queryError.message);
    return json(500, { error: 'internal_error', message: 'Could not query topups.' });
  }

  let checked = 0;
  let confirmed = 0;
  let stillPending = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const topup of stuckTopups ?? []) {
    checked++;
    try {
      const result = await provider.checkCollectionStatus(topup.id);
      if (result.status === 'succeeded' && result.providerChargeId) {
        const { error: confirmError } = await db.rpc('fn_confirm_topup', {
          p_topup_id: topup.id,
          p_provider_ref: result.providerChargeId,
        });
        if (confirmError) {
          // A real failure here (e.g. wallet_frozen) is worth knowing about
          // but must not stop the rest of the batch — same "one bad row
          // doesn't kill the sweep" posture as fn_run_auto_withdraw_sweep.
          console.error(
            `reconcile-topups: fn_confirm_topup(${topup.id}) failed:`,
            confirmError.message,
          );
          errors.push(`${topup.id}: ${confirmError.message}`);
        } else {
          confirmed++;
        }
      } else if (result.status === 'failed') {
        // Flutterwave itself says this charge failed — nothing to confirm,
        // and not this function's job to flip topups.status to 'failed'
        // unprompted (a later retry / expiry sweep owns that state
        // transition); just don't count it as still-waiting noise.
        failed++;
      } else {
        stillPending++;
      }
    } catch (e) {
      console.error(`reconcile-topups: checkCollectionStatus(${topup.id}) threw:`, e);
      errors.push(`${topup.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return json(200, { checked, confirmed, still_pending: stillPending, failed, errors });
});
