/**
 * Flutterwave adapter — implements `PaymentProvider` (CLAUDE.md rule #5:
 * every payment call goes through this interface, never the vendor SDK
 * directly from a feature module).
 *
 * SESSION 3 STATUS — real implementation, built and verified against
 * Flutterwave's live v4 API using real (production) credentials the user
 * provided, not guessed from stale docs. Confirmed live, read-only, before
 * writing any of this: the OAuth2 token exchange works, the credentials are
 * LIVE/production (the sandbox host rejects them with 403; the production
 * host `f4bexperience.flutterwave.com` returns real merchant data), and a
 * one-time, non-monetary `/transfers/senders` registration succeeded
 * (`FLW_TRANSFER_SENDER_ID`). See docs/00-SESSION-HANDOFF.md for the full
 * research trail and every doc URL consulted.
 *
 * Auth: OAuth2 client_credentials against
 * https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token
 * — `FLW_CLIENT_ID`/`FLW_CLIENT_SECRET`, not a static Bearer secret key.
 * Tokens last 10 minutes; cached at module scope and refreshed a minute
 * early, which helps across warm Edge Function invocations but isn't
 * required for correctness (a cold start just fetches a fresh one).
 *
 * `resolveCustomerId` + `initiateCollection` — NGN bank transfer only, no
 * card tokenization (see provider.ts's `CollectionResult` comment for why:
 * PCI scope stays off the mobile app entirely, matching CLAUDE.md's "stay
 * lite" guidance). Flow: resolve-or-create a Customer (its own step — see
 * provider.ts's `CollectionRequest` comment for a real bug this fixed) ->
 * create a dynamic virtual account via `/virtual-accounts`, which returns a
 * real, immediately-usable account number in one call. Confirmed live this
 * session by actually calling it — the docs originally suggested a
 * PaymentMethod + Charge model (`/payment-methods` + `/charges`), but
 * `/payment-methods`' documented `bank_transfer` type is rejected by the
 * real API, and `/virtual-accounts` directly does exactly what's needed
 * (see `initiateCollection`'s own comment for the full story). `reference`
 * is what Flutterwave should echo back on the eventual `charge.completed`
 * webhook for `webhook-flutterwave` to match against — not yet confirmed
 * against a real funded transfer, see below.
 *
 * `initiatePayout` — `/transfers`, referencing a pre-created recipient
 * (`bank_accounts.provider_account_id`, per provider.ts's `PayoutRequest`
 * comment) and this project's own registered sender
 * (`FLW_TRANSFER_SENDER_ID`). Confirmed live this session: a transfer to a
 * deliberately-fake recipient id came back a real `RECIPIENT_NOT_FOUND`
 * (404), proving the whole request shape is accepted up to that point.
 *
 * `verifyWebhook` — CORRECTED AGAIN, 2026-09-13, same day as the JWT-gate
 * and Buffer-import fixes below, after the credit-not-landing bug recurred
 * even with both of *those* fixes deployed and passing. Re-diagnosed from
 * scratch rather than assuming that writeup was complete (it wasn't): this
 * function was checking a header (`flutterwave-signature`) Flutterwave
 * never sends, verified with an algorithm (HMAC-SHA256, base64) Flutterwave
 * never runs. The "confirmed against Flutterwave's current webhook docs"
 * claim this comment used to make was wrong — re-fetched
 * developer.flutterwave.com/docs/webhooks and .../reference/webhooks fresh,
 * independently, twice, both agreeing: the real header is **`verif-hash`**,
 * and verification is a **plain string comparison** against the dashboard-
 * configured secret — no HMAC, no digest, nothing computed over the body at
 * all. Also wrong: the payload envelope is `{ event, data }`, not
 * `{ type, data }`, there is no top-level `id` field for idempotency (see
 * this function's own comment on how `eventId` is synthesized instead), and
 * a charge's merchant-side reference lives at `data.tx_ref`, not
 * `data.reference` (transfers *do* use `data.reference` — the two resource
 * types don't share a convention). See
 * supabase/functions/webhook-flutterwave/index.ts's header comment for the
 * full incident, including the live ground-truth check that proved this was
 * actively broken (two real ₦100 payments made the same day, both
 * `status: "succeeded"` at Flutterwave, both stuck `pending` in this DB
 * with `webhook_events_seen` still completely empty).
 *
 * A second, unrelated bug found via the same incident, still fixed:
 * `Buffer.from(...)` here relied on the global `Buffer` with no explicit
 * import. A local `deno run` tolerates this; Supabase's deployed
 * edge-runtime does not, and crashed with a 500 on every real request that
 * reached this code. Fixed with an explicit
 * `import { Buffer } from 'node:buffer'`.
 *
 * Lesson for whoever touches this next: the previous "confirmed live"
 * language in this comment described *reading* Flutterwave's docs, never
 * *receiving* one real raw webhook request and inspecting it byte-for-byte
 * — reading docs confidently is not the same discipline as the live-API
 * probing this project otherwise prides itself on for the REST endpoints,
 * and it silently broke this one specific thing for weeks. If this ever
 * looks broken again, don't re-read the docs and guess — check
 * `webhook_events_seen` row count directly, and if it's not growing, add
 * temporary unconditional logging of the raw incoming header names/body
 * before touching the verification logic itself.
 */

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type {
  Bank,
  CollectionRequest,
  CollectionResult,
  CreateTransferRecipientRequest,
  CreateTransferRecipientResult,
  PaymentProvider,
  PayoutRequest,
  PayoutResult,
  ResolveBankAccountRequest,
  ResolveBankAccountResult,
  ResolveCustomerRequest,
  WebhookVerification,
} from './provider.ts';

export class PaymentProviderError extends Error {
  constructor(
    operation: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Flutterwave ${operation} failed: HTTP ${status} — ${body.slice(0, 500)}`);
    this.name = 'PaymentProviderError';
  }
}

export interface FlutterwaveConfig {
  clientId: string;
  clientSecret: string;
  /** sandbox | production — see docs/authentication: separate credential
   * pairs per environment, and this project's confirmed pair is production. */
  environment: 'sandbox' | 'production';
  /** HMAC-SHA256 key for verifying the `flutterwave-signature` webhook header. */
  webhookSecretHash: string;
  /** Platform's own `/transfers/senders` id — required on every payout. */
  transferSenderId: string;
}

const BASE_URLS: Record<FlutterwaveConfig['environment'], string> = {
  sandbox: 'https://developersandbox-api.flutterwave.com',
  production: 'https://f4bexperience.flutterwave.com',
};

const TOKEN_URL = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';

// Module-scope token cache, keyed by client id — a warm Edge Function
// invocation reuses it instead of round-tripping the IDP on every call in
// the same request (buy-credit alone makes 3 downstream API calls).
// Refreshed a minute before the documented 10-minute expiry.
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function getAccessToken(config: FlutterwaveConfig): Promise<string> {
  const cached = tokenCache.get(config.clientId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'client_credentials',
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new PaymentProviderError('oauth token exchange', res.status, body);
  }

  const parsed = JSON.parse(body) as { access_token: string; expires_in: number };
  tokenCache.set(config.clientId, {
    accessToken: parsed.access_token,
    expiresAt: Date.now() + (parsed.expires_in - 60) * 1000,
  });
  return parsed.access_token;
}

// The production host (f4bexperience.flutterwave.com) was observed to be
// flaky during this session's own research — intermittent 503s and
// ECONNRESET on otherwise-valid requests, recovering on retry every time.
// A one-shot payment call failing outright on transient infra flake is a
// worse outcome than one retry, so idempotent (GET, and POST with an
// X-Idempotency-Key) calls get a couple of quick retries on network-level
// failure or 502/503/504 specifically — never on a 4xx, which is a real
// rejection retrying won't fix.
async function flwFetch(
  config: FlutterwaveConfig,
  path: string,
  options: { method: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string },
): Promise<unknown> {
  const accessToken = await getAccessToken(config);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'X-Trace-Id': crypto.randomUUID(),
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['X-Idempotency-Key'] = options.idempotencyKey;

  const url = `${BASE_URLS[config.environment]}${path}`;
  const attempts = 3;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: options.method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const text = await res.text();

      if (res.ok) {
        return text ? JSON.parse(text) : null;
      }
      if (res.status >= 502 && res.status <= 504 && attempt < attempts - 1) {
        continue; // transient gateway error — retry
      }
      throw new PaymentProviderError(`${options.method} ${path}`, res.status, text);
    } catch (e) {
      lastError = e;
      if (e instanceof PaymentProviderError) throw e;
      if (attempt === attempts - 1) throw e;
      // network-level failure (ECONNRESET etc.) — retry
    }
  }
  throw lastError;
}

interface FlwCustomer {
  id: string;
}

interface FlwVirtualAccount {
  id: string;
  account_number: string;
  account_bank_name: string;
  account_expiration_datetime?: string;
}

interface FlwTransfer {
  id: string;
  status: string;
}

export function createFlutterwaveProvider(config: FlutterwaveConfig): PaymentProvider {
  return {
    name: 'flutterwave',

    async resolveCustomerId(request: ResolveCustomerRequest): Promise<string> {
      // https://developer.flutterwave.com/reference/customers_create — no
      // find-by-email lookup exists in v4, which is exactly why this is
      // its own step the caller resolves and persists *before* attempting
      // any collection (see provider.ts's CollectionRequest comment): a
      // second call with the same email is a real 409
      // CUSTOMER_ALREADY_EXISTS, confirmed live, not a safe retry.
      const [countryCode, ...numberParts] = [
        (request.phone ?? '').slice(0, (request.phone ?? '').length - 10),
        (request.phone ?? '').slice(-10),
      ];
      const customer = (await flwFetch(config, '/customers', {
        method: 'POST',
        body: {
          email: request.email,
          name: request.name ? { first: request.name } : undefined,
          phone:
            request.phone && numberParts.length && countryCode
              ? { country_code: countryCode.replace('+', ''), number: numberParts.join('') }
              : undefined,
        },
        idempotencyKey: `customer-${request.email}`,
      })) as { data: FlwCustomer };
      return customer.data.id;
    },

    async initiateCollection(request: CollectionRequest): Promise<CollectionResult> {
      // /virtual-accounts, not /payment-methods + /charges — confirmed
      // live this session (see docs/00-SESSION-HANDOFF.md's session-3
      // section): payment-methods' documented 'bank_transfer' type is
      // actually rejected by the real API ('bank_account' is accepted
      // instead, but returns an empty bank_account sub-object — doesn't
      // actually produce a virtual account number, at least not via any
      // field combination tried). /virtual-accounts with
      // account_type: 'dynamic' does exactly what's needed in one call —
      // a real account number scoped to this top-up's amount and
      // reference — and, contrary to the original docs read for this
      // endpoint, does NOT require bvn/nin when dynamic (only relevant
      // for a reusable 'static' account, which this project doesn't use).
      // See https://developer.flutterwave.com/docs/pay-with-bank-transfer
      const virtualAccount = (await flwFetch(config, '/virtual-accounts', {
        method: 'POST',
        body: {
          reference: request.reference,
          customer_id: request.providerCustomerId,
          amount: request.amountKobo / 100,
          currency: 'NGN',
          account_type: 'dynamic',
          narration: 'InvolveMe top-up',
        },
        idempotencyKey: `va-${request.reference}`,
      })) as { data: FlwVirtualAccount };

      return {
        providerReference: virtualAccount.data.id,
        instructions: {
          type: 'bank_transfer',
          accountNumber: virtualAccount.data.account_number,
          bankName: virtualAccount.data.account_bank_name,
          accountName: null,
          expiresAt: virtualAccount.data.account_expiration_datetime ?? null,
        },
      };
    },

    async initiatePayout(request: PayoutRequest): Promise<PayoutResult> {
      // https://developer.flutterwave.com/reference/transfers_post
      const transfer = (await flwFetch(config, '/transfers', {
        method: 'POST',
        body: {
          action: 'instant',
          reference: request.reference,
          narration: 'InvolveMe withdrawal',
          payment_instruction: {
            recipient_id: request.recipientId,
            sender_id: config.transferSenderId,
            source_currency: 'NGN',
            amount: { value: request.amountKobo / 100, applies_to: 'source_currency' },
          },
        },
        idempotencyKey: `transfer-${request.reference}`,
      })) as { data: FlwTransfer };

      // Transfer statuses per the docs: NEW, PENDING, INITIATED, FAILED,
      // SUCCESSFUL, CANCELLED. PayoutResult only distinguishes
      // pending/processing (final success/failure arrives later via the
      // transfer.disburse/transfer.reversal webhook, per
      // webhook-flutterwave) — FAILED/CANCELLED at creation time is
      // unexpected for an "instant" action and treated as a hard error
      // rather than silently reported as in-flight.
      if (transfer.data.status === 'FAILED' || transfer.data.status === 'CANCELLED') {
        throw new PaymentProviderError(
          'POST /transfers',
          502,
          `transfer rejected immediately: status=${transfer.data.status}`,
        );
      }

      return {
        providerReference: transfer.data.id,
        status: transfer.data.status === 'NEW' ? 'pending' : 'processing',
      };
    },

    // New this session, for link-bank-account — the flow that actually
    // populates bank_accounts.provider_account_id for a real user (see
    // PayoutRequest's comment: nothing had ever called this before).

    async listBanks(): Promise<Bank[]> {
      // https://developer.flutterwave.com/reference/banks_get
      const result = (await flwFetch(config, '/banks?country=NG', { method: 'GET' })) as {
        data: { code: string; name: string }[];
      };
      return result.data.map((b) => ({ code: b.code, name: b.name }));
    },

    async resolveBankAccountName(
      request: ResolveBankAccountRequest,
    ): Promise<ResolveBankAccountResult> {
      // https://developer.flutterwave.com/reference/bank_account_resolve_post
      const result = (await flwFetch(config, '/banks/account-resolve', {
        method: 'POST',
        body: {
          currency: 'NGN',
          account: { code: request.bankCode, number: request.accountNumber },
        },
      })) as { data: { account_name: string } };
      return { accountName: result.data.account_name };
    },

    async createTransferRecipient(
      request: CreateTransferRecipientRequest,
    ): Promise<CreateTransferRecipientResult> {
      // https://developer.flutterwave.com/reference/transfers_recipients_create
      const result = (await flwFetch(config, '/transfers/recipients', {
        method: 'POST',
        body: {
          type: 'bank_ngn',
          bank: { account_number: request.accountNumber, code: request.bankCode },
          destination_currency: 'NGN',
        },
        idempotencyKey: `recipient-${request.bankCode}-${request.accountNumber}`,
      })) as { data: { id: string } };
      return { recipientId: result.data.id };
    },

    verifyWebhook(rawBody: string, signatureHeader: string | null): WebhookVerification {
      // CORRECTED 2026-09-13, this time against the actual documented
      // contract, not a remembered/assumed one — see
      // supabase/functions/webhook-flutterwave/index.ts's header comment
      // for the full incident this replaces. Ground truth (fetched fresh
      // from developer.flutterwave.com/docs/webhooks and
      // developer.flutterwave.com/reference/webhooks, independently, twice,
      // both agreeing): the header is **`verif-hash`**, not
      // `flutterwave-signature`, and verification is a **plain string
      // comparison** against the secret hash configured in the dashboard —
      // there is no HMAC, no digest, no signing of the body at all. The
      // previous version of this function checked a header Flutterwave
      // never sends, with an algorithm Flutterwave never runs — meaning
      // every real webhook was silently rejected from day one, a strictly
      // worse bug than the JWT-gate/Buffer issues fixed earlier the same
      // day, because those were platform/runtime issues around otherwise-
      // correct code; this was the verification logic itself checking the
      // wrong thing. Confirmed live and current as of this fix: two real
      // ₦100 top-up charges made the same day this fix shipped
      // (chg_uaP4X5W6rO, chg_8AHFxYniLv — both `status: "succeeded"` per
      // Flutterwave's own `GET /charges`) sat with `webhook_events_seen`
      // still completely empty (0 rows total, checked directly against the
      // dev DB) at the moment this bug was found — proof this was live and
      // active, not hypothetical.
      if (!signatureHeader) {
        console.error('verifyWebhook: no verif-hash header on inbound request');
        return { isValid: false, eventId: '', payload: null };
      }

      // Constant-time comparison — a naive `===` leaks timing information
      // an attacker could use to forge a valid signature byte-by-byte.
      // Buffers must be equal length for timingSafeEqual; mismatched
      // length is itself a fast, safe rejection (no secret-dependent
      // branch on the content being compared).
      const expectedBuf = Buffer.from(config.webhookSecretHash, 'utf8');
      const actualBuf = Buffer.from(signatureHeader, 'utf8');
      const isValid =
        expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);

      if (!isValid) {
        // Logged deliberately (not just returned): the last time this
        // check silently failed for a structural reason (wrong header
        // name entirely), nothing surfaced it for weeks. This doesn't log
        // the secret or the header value, just the fact of a mismatch and
        // the lengths involved, which is enough to distinguish "wrong
        // secret configured" from "header genuinely absent/malformed" in
        // the logs without leaking anything sensitive.
        console.error(
          `verifyWebhook: verif-hash mismatch (received length=${actualBuf.length}, expected length=${expectedBuf.length})`,
        );
        return { isValid: false, eventId: '', payload: null };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        console.error('verifyWebhook: signature valid but body is not valid JSON');
        return { isValid: false, eventId: '', payload: null };
      }

      // No documented top-level delivery/event id exists in Flutterwave's
      // real payload (confirmed against the docs' own examples — the
      // envelope is just `{ event, data }`, nothing else at the top
      // level). `data.id` (the underlying charge/transfer id) is the only
      // stable identifier a retry of the *same* event will repeat, so the
      // idempotency key is synthesized as `${event}:${data.id}` — prefixed
      // with the event name so a charge and a transfer that happen to
      // share a numeric id at Flutterwave can never collide in
      // `webhook_events_seen`.
      const p = payload as { event?: unknown; data?: { id?: unknown } };
      const eventName = typeof p.event === 'string' ? p.event : '';
      const dataId = p.data?.id != null ? String(p.data.id) : '';
      const eventId = eventName && dataId ? `${eventName}:${dataId}` : '';

      return { isValid: true, eventId, payload };
    },
  };
}
