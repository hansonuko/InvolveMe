/**
 * Flutterwave adapter — implements `PaymentProvider` (CLAUDE.md rule #5:
 * every payment call goes through this interface, never the vendor SDK
 * directly from a feature module).
 *
 * PHASE 2 BATCH 2 STATUS — deliberately split, not a full implementation:
 *
 * `verifyWebhook` is real and testable now: signature verification is a
 * self-contained cryptographic check (HMAC-SHA256 of the raw body against
 * `FLW_WEBHOOK_SECRET_HASH`) that doesn't depend on which Flutterwave API
 * generation ends up handling collections/payouts.
 *
 * `initiateCollection` and `initiatePayout` are deliberately NOT
 * implemented — they throw `PaymentProviderNotImplementedError`. While
 * building this batch, Flutterwave's current live docs
 * (developer.flutterwave.com) turned out to describe a materially
 * different API than this project's `.env`/docs assumed: OAuth2
 * client_id/client_secret token exchange (not `FLW_SECRET_KEY` as a static
 * Bearer token), new required headers, recipient-object-based transfers,
 * and a Customer/PaymentMethod/Charge/Order model for collections instead
 * of a single "give me a checkout URL" call. Rather than guess at a
 * contract against an unfamiliar, possibly-mid-migration vendor API, this
 * was flagged back and deferred — see docs/00-SESSION-HANDOFF.md's batch 2
 * section for the full finding. The DB layer and Edge Functions that call
 * this adapter are built and tested against the *stub* (which is exactly
 * how a real provider outage/failure looks to them), so `withdraw`'s
 * compensating-transaction path (`fn_fail_withdrawal` on provider failure)
 * is genuinely exercised, not just written and hoped about.
 *
 * The `verif-hash`-header / direct-string-compare scheme in the *original*
 * docs/05-API-REALTIME-SPEC.md draft was the older (v3-era) mechanism this
 * project's docs were written against; what's implemented below is the
 * HMAC-SHA256 / `flutterwave-signature`-header scheme confirmed against
 * Flutterwave's current webhook docs. Revisit alongside whichever API
 * generation gets picked for collections/payouts — they may not agree.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CollectionRequest,
  CollectionResult,
  PaymentProvider,
  PayoutRequest,
  PayoutResult,
  WebhookVerification,
} from './provider.ts';

export class PaymentProviderNotImplementedError extends Error {
  constructor(operation: string) {
    super(
      `Flutterwave ${operation} is not implemented yet — pending a decision on which Flutterwave ` +
        'API generation to target (see docs/00-SESSION-HANDOFF.md, Phase 2 batch 2).',
    );
    this.name = 'PaymentProviderNotImplementedError';
  }
}

export interface FlutterwaveConfig {
  /** HMAC-SHA256 key for verifying the `flutterwave-signature` webhook header. */
  webhookSecretHash: string;
}

export function createFlutterwaveProvider(config: FlutterwaveConfig): PaymentProvider {
  return {
    name: 'flutterwave',

    async initiateCollection(_request: CollectionRequest): Promise<CollectionResult> {
      throw new PaymentProviderNotImplementedError('initiateCollection (buy-credit)');
    },

    async initiatePayout(_request: PayoutRequest): Promise<PayoutResult> {
      throw new PaymentProviderNotImplementedError('initiatePayout (withdraw)');
    },

    verifyWebhook(rawBody: string, signatureHeader: string | null): WebhookVerification {
      if (!signatureHeader) {
        return { isValid: false, eventId: '', payload: null };
      }

      const expected = createHmac('sha256', config.webhookSecretHash).update(rawBody).digest('hex');

      // Constant-time comparison — a naive `===` leaks timing information
      // an attacker could use to forge a valid signature byte-by-byte.
      // Buffers must be equal length for timingSafeEqual; mismatched
      // length is itself a fast, safe rejection (no secret-dependent
      // branch on the content being compared).
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(signatureHeader, 'hex');
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
