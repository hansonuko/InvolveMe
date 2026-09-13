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
 * `verifyWebhook` — HMAC-SHA256 of the raw body against
 * `FLW_WEBHOOK_SECRET_HASH`, digest **base64** (confirmed against
 * Flutterwave's current webhook docs, code example included) — the
 * previous version of this file used `hex`, which would have rejected
 * every real webhook Flutterwave ever sent. Caught before it shipped by
 * reading the doc's own verification code sample rather than assuming the
 * v3-era convention still held.
 *
 * A second, real bug in this same function, found via a real incident
 * (2026-09-13): `Buffer.from(...)` here relied on the global `Buffer` with
 * no explicit import. A local `deno run` tolerates this; Supabase's
 * deployed edge-runtime does not, and crashed with a 500 on every real
 * request that reached this code. Fixed with an explicit
 * `import { Buffer } from 'node:buffer'` — see
 * supabase/functions/webhook-flutterwave/index.ts's header comment for the
 * full incident (this bug was masked by an unrelated platform-level JWT
 * gateway issue that was rejecting every webhook before this code ever ran,
 * so the two had to be found and fixed in sequence, not simultaneously).
 *
 * What's still NOT fully verified end-to-end: a real virtual-account
 * funding *did* complete for real this session (confirmed independently via
 * `GET /charges?customer_id=...` returning `status: "succeeded"` for a real
 * ₦100 transfer) — but the corresponding webhook was never actually
 * *observed* arriving, only reconstructed and manually confirmed via
 * `fn_confirm_topup` after the fact, since both bugs above meant it could
 * never have arrived successfully before they were fixed. A real payout has
 * also never disbursed. Whether a real webhook actually lands now that both
 * bugs are fixed is the next thing to watch for, not something already
 * proven — `supabase/tests/webhook-flutterwave-deployed-smoke.test.js`
 * proves the endpoint itself is healthy, not that Flutterwave's real
 * delivery reaches it.
 */

import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
      if (!signatureHeader) {
        return { isValid: false, eventId: '', payload: null };
      }

      // Base64 digest, not hex — confirmed against
      // https://developer.flutterwave.com/docs/webhooks's own verification
      // code sample. (The previous version of this file used hex, which
      // would have rejected every real webhook.)
      const expected = createHmac('sha256', config.webhookSecretHash)
        .update(rawBody)
        .digest('base64');

      // Constant-time comparison — a naive `===` leaks timing information
      // an attacker could use to forge a valid signature byte-by-byte.
      // Buffers must be equal length for timingSafeEqual; mismatched
      // length is itself a fast, safe rejection (no secret-dependent
      // branch on the content being compared).
      const expectedBuf = Buffer.from(expected, 'utf8');
      const actualBuf = Buffer.from(signatureHeader, 'utf8');
      const isValid =
        expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);

      if (!isValid) {
        return { isValid: false, eventId: '', payload: null };
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return { isValid: false, eventId: '', payload: null };
      }

      const eventId =
        typeof (payload as { id?: unknown })?.id === 'string' ? (payload as { id: string }).id : '';

      return { isValid: true, eventId, payload };
    },
  };
}
