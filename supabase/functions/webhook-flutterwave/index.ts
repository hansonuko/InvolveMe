// POST /functions/v1/webhook-flutterwave
//
// Server-to-server only, not called by the app — no caller JWT, per
// docs/05-API-REALTIME-SPEC.md. Authenticity comes entirely from the
// signature check (CLAUDE.md rule #6: "signature-verified, full stop, no
// exceptions for just testing").
//
// Routes two event families to the DB functions that already handle their
// idempotency: `charge.completed` → fn_confirm_topup (buy-credit
// confirmation, only when data.status is 'succeeded' — this event fires for
// every terminal charge state, not just successful ones, per
// developer.flutterwave.com/reference/charges_post's status list), and
// `transfer.disburse`/`transfer.reversal` → fn_complete_withdrawal /
// fn_fail_withdrawal (withdrawal completion — see the batch-2 migration's
// header comment for why fn_complete_withdrawal exists). Both `reference`
// fields are assumed to equal the corresponding `topups.id` /
// `withdrawals.id` — the convention this project's own code sets when
// creating those objects at Flutterwave.
//
// Corrected this session (see docs/00-SESSION-HANDOFF.md's session-3
// section for the live research): the event names were originally
// `transfer.completed`/`transfer.failed`, a v3-era guess never confirmed
// against v4's actual docs — the real names are `transfer.disburse` and
// `transfer.reversal`, per developer.flutterwave.com/reference (API
// overview's webhook-events list). Still not confirmed against a live
// transfer's actual payload shape (no real payout has been triggered from
// this app yet) — an unmapped/wrong event type is acknowledged with 200 and
// no DB action either way (see the bottom of this handler), so a residual
// naming mismatch fails safe rather than crashing or double-processing.

import { serviceRoleClient } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';

interface FlutterwaveWebhookPayload {
  id?: string;
  type?: string;
  data?: {
    id?: string | number;
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
  const signature = req.headers.get('flutterwave-signature');

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
    isFirstDelivery = await claimWebhookEvent(db, eventId, payload.type);
  } catch {
    return errorResponse(500, 'internal_error', 'Could not record webhook event.');
  }

  if (!isFirstDelivery) {
    // Already processed — ack without reprocessing, per docs/05 §1.
    return json(200, { status: 'already_processed' });
  }

  const type = payload.type ?? '';
  const reference = payload.data?.reference;
  const providerRef = payload.data?.id != null ? String(payload.data.id) : '';
  const status = payload.data?.status;

  if (type === 'charge.completed' && reference && status === 'succeeded') {
    const { error } = await db.rpc('fn_confirm_topup', {
      p_topup_id: reference,
      p_provider_ref: providerRef,
    });
    if (error) {
      // Logged, not thrown: a malformed/stale reference retrying forever
      // wouldn't resolve itself, and Flutterwave still needs its 200.
      console.error('webhook-flutterwave: fn_confirm_topup failed:', error.message);
    }
  } else if (type === 'charge.completed' && reference) {
    // completed but not succeeded (failed/voided) — mark the topup failed
    // directly. No balance was ever touched for a pending topup (per
    // fn_buy_credit's own header comment), so this is a plain status
    // update, not something that needs a SECURITY DEFINER function.
    const { error } = await db
      .from('topups')
      .update({ status: 'failed' })
      .eq('id', reference)
      .eq('status', 'pending');
    if (error) {
      console.error('webhook-flutterwave: marking topup failed errored:', error.message);
    }
  } else if (type === 'transfer.disburse' && reference) {
    const { error } = await db.rpc('fn_complete_withdrawal', {
      p_withdrawal_id: reference,
      p_provider_ref: providerRef,
    });
    if (error) {
      console.error('webhook-flutterwave: fn_complete_withdrawal failed:', error.message);
    }
  } else if (type === 'transfer.reversal' && reference) {
    const { error } = await db.rpc('fn_fail_withdrawal', { p_withdrawal_id: reference });
    if (error) {
      console.error('webhook-flutterwave: fn_fail_withdrawal failed:', error.message);
    }
  }
  // Every other event type (order.authorization, refund.completed,
  // unrecognized future types, etc.): acknowledged, no DB action — not a
  // failure, just nothing to do yet at this end.

  return json(200, { status: 'processed' });
});
