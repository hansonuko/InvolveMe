// POST /functions/v1/buy-credit
//
// Contract: docs/05-API-REALTIME-SPEC.md §1. Built this session now that
// packages/payments/flutterwave.ts's initiateCollection is real (see its
// header comment and docs/00-SESSION-HANDOFF.md's session-3 section) —
// previously deferred entirely pending the Flutterwave API-generation
// decision, which is now resolved: v4, live/production credentials.
//
// No financial logic here (CLAUDE.md rule #1): fn_buy_credit computes the
// fee/credits split server-side and creates the pending topups row; this
// function only authenticates, calls it, then calls
// PaymentProvider.initiateCollection() to get a real bank-transfer virtual
// account for the customer to pay into. Credits are issued only once the
// webhook confirms the charge (fn_confirm_topup, via webhook-flutterwave)
// — never on this call returning 200, since a client-visible 200 here just
// means "here's where to send the money," not "payment received."
//
// customer_id / email: Flutterwave v4 requires a Customer object with an
// email (see flutterwave.ts's initiateCollection comment) but this app's
// auth is phone-only (docs/01-ARCHITECTURE.md) — users have no email on
// file. A stable synthetic email is used instead
// (u-<user_id>@users.involveme.invalid); it's never shown to the user or
// used for delivery, only as the identifier Flutterwave's Customer object
// requires. The real provider customer id it creates is cached on
// users.provider_customer_id (new this session) so a returning user's
// second top-up reuses it instead of creating a duplicate Customer record.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { parseBody } from '../_shared/validate.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';

// Defense-in-depth (docs/19-SECURITY-HARDENING-SCOPING.md §3) — each call
// hits the live Flutterwave API regardless of outcome (this file's own
// header comment), so bounding call rate here also bounds real provider
// cost, not just app-side load. Top-ups are an occasional action, not a
// per-minute one — generous enough for a legitimate retry-after-failure
// burst, tight enough to bound a scripted hammer.
const BUY_CREDIT_MAX = 10;
const BUY_CREDIT_WINDOW_SECONDS = 60 * 60;

const BuyCreditRequestSchema = z.object({
  amount_kobo: z
    .number({
      required_error: 'amount_kobo must be a positive integer.',
      invalid_type_error: 'amount_kobo must be a positive integer.',
    })
    .int('amount_kobo must be a positive integer.')
    .positive('amount_kobo must be a positive integer.'),
});

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

function mapBuyCreditError(pgMessage: string): Response {
  if (pgMessage.startsWith('invalid_amount')) {
    return errorResponse(400, 'invalid_amount', 'amount_kobo must be a positive integer.');
  }
  if (pgMessage.startsWith('daily_topup_limit_exceeded')) {
    // docs/06-SECURITY-FRAUD-LOOPHOLES.md §4 — a new, unverified account's
    // daily top-up cap. Verifying (Tier 1 KYC) removes this limit, so the
    // message points there rather than just saying "try again later."
    return errorResponse(
      429,
      'daily_topup_limit_exceeded',
      "You've reached today's top-up limit for a new, unverified account. Verify your identity in Settings to remove this limit.",
    );
  }
  console.error('buy-credit: unmapped DB error:', pgMessage);
  return errorResponse(500, 'internal_error', 'Something went wrong.');
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
    console.error('buy-credit: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(BuyCreditRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();

  const rateAllowed = await checkRateLimit(
    db,
    `buy-credit:user:${user.id}`,
    BUY_CREDIT_MAX,
    BUY_CREDIT_WINDOW_SECONDS,
  );
  if (!rateAllowed) {
    return errorResponse(429, 'rate_limited', 'Too many top-up attempts, try again later.');
  }

  const { data: userRow, error: userError } = await db
    .from('users')
    .select('phone, display_name, provider_customer_id')
    .eq('id', user.id)
    .single();
  if (userError || !userRow) {
    console.error('buy-credit: user lookup failed:', userError?.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const { data: topupId, error: buyCreditError } = await db.rpc('fn_buy_credit', {
    p_user_id: user.id,
    p_amount_kobo: payload.amount_kobo,
    p_provider: 'flutterwave',
  });
  if (buyCreditError) {
    return mapBuyCreditError(buyCreditError.message);
  }

  const { data: topup, error: topupError } = await db
    .from('topups')
    .select('amount_kobo_paid, platform_fee_kobo, credits_issued')
    .eq('id', topupId)
    .single();
  if (topupError || !topup) {
    console.error(
      'buy-credit: could not read back the topup it just created:',
      topupError?.message,
    );
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());

  // Resolved and persisted as its own step, before ever attempting a
  // collection — see provider.ts's CollectionRequest comment for the real
  // bug (a live 409 CUSTOMER_ALREADY_EXISTS) this fixes: creating the
  // customer *inside* the same try/catch as the collection meant a
  // successfully-created customer whose id never got saved (because a
  // later step failed) had no way to be recovered on retry.
  let providerCustomerId = userRow.provider_customer_id;
  if (!providerCustomerId) {
    try {
      providerCustomerId = await provider.resolveCustomerId({
        email: `u-${user.id}@users.involveme.invalid`,
        name: userRow.display_name ?? undefined,
        phone: userRow.phone,
      });
    } catch (e) {
      console.error('buy-credit: provider.resolveCustomerId failed:', e);
      const { error: failError } = await db
        .from('topups')
        .update({ status: 'failed' })
        .eq('id', topupId)
        .eq('status', 'pending');
      if (failError) {
        console.error('buy-credit: marking topup failed ALSO errored:', failError.message);
      }
      return errorResponse(
        503,
        'payment_provider_unavailable',
        'Could not start this top-up right now. Nothing has been charged.',
      );
    }

    const { error: persistError } = await db
      .from('users')
      .update({ provider_customer_id: providerCustomerId })
      .eq('id', user.id);
    if (persistError) {
      // Non-fatal for *this* request (the id is already resolved and used
      // below) — but if this write keeps failing, every future top-up for
      // this user will hit the same 409 resolveCustomerId now guards
      // against elsewhere, so it's logged loudly rather than swallowed.
      console.error(
        'buy-credit: resolved a provider customer id but could not cache it — next top-up will fail:',
        persistError.message,
      );
    }
  }

  try {
    const collection = await provider.initiateCollection({
      amountKobo: payload.amount_kobo,
      providerCustomerId,
      reference: topupId as string,
    });

    const { error: refError } = await db
      .from('topups')
      .update({ provider_ref: collection.providerReference })
      .eq('id', topupId);
    if (refError) {
      console.error('buy-credit: could not record provider_ref:', refError.message);
    }

    return json(200, {
      topup_id: topupId,
      amount_kobo_paid: topup.amount_kobo_paid,
      platform_fee_kobo: topup.platform_fee_kobo,
      credits_issued: topup.credits_issued,
      provider: 'flutterwave',
      bank_transfer: {
        account_number: collection.instructions.accountNumber,
        bank_name: collection.instructions.bankName,
        account_name: collection.instructions.accountName,
        expires_at: collection.instructions.expiresAt,
      },
    });
  } catch (e) {
    console.error('buy-credit: provider.initiateCollection failed:', e);

    const { error: failError } = await db
      .from('topups')
      .update({ status: 'failed' })
      .eq('id', topupId)
      .eq('status', 'pending');
    if (failError) {
      console.error('buy-credit: marking topup failed ALSO errored:', failError.message);
    }

    return errorResponse(
      503,
      'payment_provider_unavailable',
      'Could not start this top-up right now. Nothing has been charged.',
    );
  }
});
