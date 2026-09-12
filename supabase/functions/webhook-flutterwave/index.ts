// POST /functions/v1/webhook-flutterwave
//
// Server-to-server only, not called by the app — no caller JWT, per
// docs/05-API-REALTIME-SPEC.md. Authenticity comes entirely from the
// signature check (CLAUDE.md rule #6: "signature-verified, full stop, no
// exceptions for just testing").
//
// Routes two event families to the DB functions that already handle their
// idempotency: `charge.completed` → fn_confirm_topup (buy-credit
// confirmation), `transfer.completed`/`transfer.failed` →
// fn_complete_withdrawal / fn_fail_withdrawal (withdrawal completion —
// see the new migration's header comment for why fn_complete_withdrawal
// exists). Both `reference` fields are assumed to equal the corresponding
// `topups.id` / `withdrawals.id` — the convention this project's own code
// sets when creating those objects at Flutterwave (buy-credit isn't built
// yet to actually do that; withdraw, in this same PR, does).
//
// The exact event `type` strings and payload shape (`data.reference`,
// `data.id`) are Flutterwave's documented v4 webhook convention as far as
// could be confirmed without a live account — see
// packages/payments/flutterwave.ts's header comment for what's confirmed
// vs. assumed.

import { serviceRoleClient } from '../_shared/auth.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';

interface FlutterwaveWebhookPayload {
  id?: string;
  type?: string;
  data?: {
    id?: string | number;
    reference?: string;
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

  const webhookSecretHash = Deno.env.get('FLW_WEBHOOK_SECRET_HASH') ?? '';
  const provider = createFlutterwaveProvider({ webhookSecretHash });
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

  if (type === 'charge.completed' && reference) {
    const { error } = await db.rpc('fn_confirm_topup', {
      p_topup_id: reference,
      p_provider_ref: providerRef,
    });
    if (error) {
      // Logged, not thrown: a malformed/stale reference retrying forever
      // wouldn't resolve itself, and Flutterwave still needs its 200.
      console.error('webhook-flutterwave: fn_confirm_topup failed:', error.message);
    }
  } else if (type === 'transfer.completed' && reference) {
    const { error } = await db.rpc('fn_complete_withdrawal', {
      p_withdrawal_id: reference,
      p_provider_ref: providerRef,
    });
    if (error) {
      console.error('webhook-flutterwave: fn_complete_withdrawal failed:', error.message);
    }
  } else if (type === 'transfer.failed' && reference) {
    const { error } = await db.rpc('fn_fail_withdrawal', { p_withdrawal_id: reference });
    if (error) {
      console.error('webhook-flutterwave: fn_fail_withdrawal failed:', error.message);
    }
  }
  // Every other event type (charge.failed, unrecognized future types,
  // etc.): acknowledged, no DB action — not a failure, just nothing to do
  // yet at this end.

  return json(200, { status: 'processed' });
});
