// POST /functions/v1/webhook-flutterwave
//
// Server-to-server only, not called by the app — no caller JWT, per
// docs/05-API-REALTIME-SPEC.md. Authenticity comes entirely from the
// signature check (CLAUDE.md rule #6: "signature-verified, full stop, no
// exceptions for just testing").
//
// MUST be deployed with `--no-verify-jwt`:
//   supabase functions deploy webhook-flutterwave --use-api --no-verify-jwt
// This is a REAL incident this project actually had (2026-09-13), not a
// theoretical warning: the first deploy used the default
// `supabase functions deploy` batch call with no per-function flags, which
// left Supabase's own platform-level JWT gateway enabled for this function.
// Flutterwave's real webhook requests (which never carry a Supabase auth
// header, only a `verif-hash` signature header — see below) were rejected
// with 401
// `UNAUTHORIZED_NO_AUTH_HEADER` by the gateway itself, before this file's
// own code ever ran — meaning every real webhook silently failed from the
// moment this function was first deployed, and `webhook_events_seen` stayed
// empty the whole time. A real user's ₦100 top-up sat unconfirmed for over
// an hour before this was caught. Confirmed via
// `supabase/tests/webhook-flutterwave-deployed-smoke.test.js` (`npm run
// test:deployed`) — the only test in this suite that hits the actual
// deployed URL rather than a local `deno run`, which is exactly why every
// other test here passing 87/87 never caught this.
//
// A second, unrelated bug surfaced by the same incident once the gateway
// was fixed: `packages/payments/flutterwave.ts`'s `verifyWebhook` used the
// global `Buffer` without an explicit `import { Buffer } from 'node:buffer'`
// — tolerated by a local `deno run` but not by Supabase's deployed
// edge-runtime, which crashed with a generic 500 on every real request past
// the gateway. Fixed there; watch for the same unguarded-global pattern in
// any future Node-compat code added to this file or its imports.
//
// RE-DIAGNOSED AND CORRECTED AGAIN, same day (2026-09-13), after the
// credit-not-landing bug recurred with both fixes above already deployed
// and passing: this handler's own field-name assumptions were wrong, on
// top of `verifyWebhook` checking the wrong header entirely (see that
// function's header comment for the full story and the live ground-truth
// check that proved it — two real same-day ₦100 payments stuck pending
// with `webhook_events_seen` still completely empty). Fetched
// developer.flutterwave.com/docs/webhooks and .../reference/webhooks fresh
// this time, twice independently, rather than trusting the previous
// session's "confirmed live" claim at face value:
//
//   - The envelope is `{ event, data }`, not `{ type, data }`.
//   - A charge's merchant reference is `data.tx_ref`, and its terminal
//     status is lowercase `'successful'` / `'failed'` — not
//     `data.reference` / `'succeeded'`.
//   - A transfer's merchant reference IS `data.reference` (transfers and
//     charges don't share a field-naming convention) and its status is
//     UPPERCASE `'SUCCESSFUL'` / `'FAILED'`.
//   - There is exactly one transfer completion event, `transfer.completed`
//     — not two separate `transfer.disburse`/`transfer.reversal` events as
//     previously guessed (that guess was never confirmed against a real
//     transfer payload, since no real payout has ever disbursed from this
//     app; flagged as unconfirmed in the docs at the time, and it turned
//     out wrong). Outcome is read from `data.status`, not the event name.
//
// Both `reference`/`tx_ref` fields are assumed to equal the corresponding
// `topups.id` / `withdrawals.id` — the convention this project's own code
// sets when creating those objects at Flutterwave (buy-credit passes the
// topup id as `reference` when creating the virtual account; withdraw
// passes the withdrawal id as `reference` when creating the transfer).
//
// An unmapped/unrecognized event or status is acknowledged with 200 and no
// DB action (see the bottom of this handler) — fails safe rather than
// crashing or guessing, but see verifyWebhook's logging: an unrecognized
// *shape* now logs loudly so a future mismatch is visible in
// `supabase functions logs webhook-flutterwave` within minutes, not
// silently invisible for weeks the way this exact bug was.
//
// Admin dashboard Phase F piece 3 (docs/14-ADMIN-DASHBOARD-SCOPING.md §5):
// a transfer.completed reference can now belong to either the user
// withdrawals table or the admin-initiated platform_withdrawals table —
// the same reference field, two possible owners, since
// fn_admin_initiate_platform_withdrawal (piece 2) reuses
// platform_withdrawals.id as the payout reference exactly like
// fn_initiate_withdrawal already does with withdrawals.id. Handled as a
// fallback, not a lookup-then-branch: try the existing (unchanged, proven)
// user-withdrawal RPC first; only on its own specific
// 'withdrawal_not_found' does this fall through to the platform-withdrawal
// equivalent. Every existing success/failure path for a real user
// withdrawal is untouched byte-for-byte — this only adds a second thing to
// try when the first one says "not mine."

import { serviceRoleClient } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import {
  notifyTopupConfirmed,
  notifyWithdrawalCompleted,
  runInBackground,
} from '../_shared/push.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';

interface FlutterwaveWebhookPayload {
  event?: string;
  data?: {
    id?: string | number;
    /** Charges: merchant reference. */
    tx_ref?: string;
    /** Transfers: merchant reference (charges and transfers don't share a
     * field name for this — confirmed against real doc examples of both). */
    reference?: string;
    status?: string;
  };
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

// Claims (provider, event_id) via upsert-ignore-duplicates: an empty
// result means another request already claimed this event (already
// processed, skip); a returned row means this call is the first to see
// it. Atomic at the database level — the unique constraint added in
// 20260912123949_webhook_events_and_withdrawal_completion.sql is what
// actually arbitrates a genuine race, this is just the claim mechanism.
// deno-lint-ignore no-explicit-any
async function claimWebhookEvent(
  db: ReturnType<typeof serviceRoleClient>,
  eventId: string,
  eventType: string | undefined,
): Promise<boolean> {
  const { data, error } = await db
    .from('webhook_events_seen')
    .upsert(
      { provider: 'flutterwave', provider_event_id: eventId, event_type: eventType ?? null },
      { onConflict: 'provider,provider_event_id', ignoreDuplicates: true },
    )
    .select('id');

  if (error) {
    console.error('webhook-flutterwave: claim failed:', error.message);
    // Fail closed on our own infra error would mean Flutterwave retries
    // forever on a bug that has nothing to do with the event itself —
    // but silently double-processing is worse. Re-throw so the caller
    // returns 500 and Flutterwave retries, rather than guessing.
    throw error;
  }

  return (data?.length ?? 0) > 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  const rawBody = await req.text();
  // 'verif-hash', not 'flutterwave-signature' — see verifyWebhook's header
  // comment. Header names are case-insensitive per the Headers spec, so
  // Deno normalizes this regardless of how Flutterwave actually cases it.
  const signature = req.headers.get('verif-hash');

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());
  const verification = provider.verifyWebhook(rawBody, signature);

  if (!verification.isValid) {
    return errorResponse(401, 'invalid_signature', 'Webhook signature verification failed.');
  }

  const payload = verification.payload as FlutterwaveWebhookPayload;
  const eventId = verification.eventId;
  if (!eventId) {
    return errorResponse(400, 'invalid_request', 'Webhook payload is missing an event id.');
  }

  const db = serviceRoleClient();

  let isFirstDelivery: boolean;
  try {
    isFirstDelivery = await claimWebhookEvent(db, eventId, payload.event);
  } catch {
    return errorResponse(500, 'internal_error', 'Could not record webhook event.');
  }

  if (!isFirstDelivery) {
    // Already processed — ack without reprocessing, per docs/05 §1.
    return json(200, { status: 'already_processed' });
  }

  const event = payload.event ?? '';
  const providerRef = payload.data?.id != null ? String(payload.data.id) : '';
  // Case-normalized once here rather than at every comparison site below —
  // charges document lowercase status strings, transfers uppercase ones
  // (both confirmed against real doc examples), and a defensive lowercase
  // compare means a future casing surprise from Flutterwave fails safe
  // (falls to the unmapped/no-op branch) instead of silently matching or
  // silently missing.
  const status = (payload.data?.status ?? '').toLowerCase();

  if (event === 'charge.completed' && payload.data?.tx_ref && status === 'successful') {
    const topupId = payload.data.tx_ref;
    const { error } = await db.rpc('fn_confirm_topup', {
      p_topup_id: topupId,
      p_provider_ref: providerRef,
    });
    if (error) {
      // Logged, not thrown: a malformed/stale reference retrying forever
      // wouldn't resolve itself, and Flutterwave still needs its 200.
      console.error('webhook-flutterwave: fn_confirm_topup failed:', error.message);
    } else {
      runInBackground(() => notifyTopupConfirmed(db, topupId));
    }
  } else if (event === 'charge.completed' && payload.data?.tx_ref) {
    // completed but not successful (failed/voided) — mark the topup failed
    // directly. No balance was ever touched for a pending topup (per
    // fn_buy_credit's own header comment), so this is a plain status
    // update, not something that needs a SECURITY DEFINER function.
    const { error } = await db
      .from('topups')
      .update({ status: 'failed' })
      .eq('id', payload.data.tx_ref)
      .eq('status', 'pending');
    if (error) {
      console.error('webhook-flutterwave: marking topup failed errored:', error.message);
    }
  } else if (event === 'transfer.completed' && payload.data?.reference && status === 'successful') {
    const reference = payload.data.reference;
    const { error } = await db.rpc('fn_complete_withdrawal', {
      p_withdrawal_id: reference,
      p_provider_ref: providerRef,
    });
    if (!error) {
      runInBackground(() => notifyWithdrawalCompleted(db, reference));
    } else if (error.message.includes('withdrawal_not_found')) {
      const { error: platformError } = await db.rpc('fn_admin_complete_platform_withdrawal', {
        p_platform_withdrawal_id: reference,
        p_provider_reference: providerRef,
      });
      if (platformError) {
        console.error(
          'webhook-flutterwave: reference matched neither withdrawals nor platform_withdrawals (fn_admin_complete_platform_withdrawal failed):',
          platformError.message,
        );
      }
    } else {
      console.error('webhook-flutterwave: fn_complete_withdrawal failed:', error.message);
    }
  } else if (event === 'transfer.completed' && payload.data?.reference) {
    const reference = payload.data.reference;
    const { error } = await db.rpc('fn_fail_withdrawal', { p_withdrawal_id: reference });
    if (error && error.message.includes('withdrawal_not_found')) {
      const { error: platformError } = await db.rpc('fn_admin_fail_platform_withdrawal', {
        p_platform_withdrawal_id: reference,
      });
      if (platformError) {
        console.error(
          'webhook-flutterwave: reference matched neither withdrawals nor platform_withdrawals (fn_admin_fail_platform_withdrawal failed):',
          platformError.message,
        );
      }
    } else if (error) {
      console.error('webhook-flutterwave: fn_fail_withdrawal failed:', error.message);
    }
  } else {
    // Every other event type, or a recognized event whose payload is
    // missing the reference field it should have: acknowledged, no DB
    // action. Logged (not just silently ack'd) specifically for the
    // "recognized event, missing field" case — that combination is exactly
    // the shape of bug this incident already had once (a real event
    // arriving in a shape the handler didn't expect) and should be visible
    // in logs immediately if it happens again, not rediscovered by a user
    // reporting missing credit weeks later.
    if (event === 'charge.completed' || event === 'transfer.completed') {
      console.error(
        `webhook-flutterwave: recognized event '${event}' but missing expected reference field — payload.data=${JSON.stringify(payload.data)}`,
      );
    }
  }

  return json(200, { status: 'processed' });
});
