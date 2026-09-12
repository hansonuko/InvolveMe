/**
 * PaymentProvider interface — every payment/payout call in the backend goes
 * through this, never directly through a vendor SDK. See CLAUDE.md rule #5
 * and docs/01-ARCHITECTURE.md.
 *
 * Implementations land in Phase 3 (docs/08-BUILD-PHASES-ROADMAP.md):
 * `flutterwave.ts` first (active), `paystack.ts` provisioned behind
 * PAYMENTS_ACTIVE_PROVIDER. This file is the contract both must satisfy —
 * intentionally empty of implementation in Phase 0.
 */

export interface CollectionRequest {
  amountKobo: number;
  customerEmail: string;
  customerPhone: string;
  reference: string;
}

export interface CollectionResult {
  checkoutUrl: string;
  providerReference: string;
}

/**
 * `recipientId` — not a raw account number/bank code. Matches
 * `bank_accounts.provider_account_id` (docs/02-DATA-MODEL.md: "tokenized by
 * provider") — InvolveMe deliberately never persists a full bank account
 * number, only a provider-issued reference, so the interface can't hand an
 * adapter raw account details to pay out with regardless of which
 * Flutterwave API generation ends up implementing this. This interface
 * originally (Phase 0) specified `accountNumber`/`bankCode`, which never
 * matched that schema decision; changed here since nothing had implemented
 * against the old shape yet. What exactly populates `recipientId` — and
 * which concrete Flutterwave endpoint/auth model `flutterwave.ts` calls —
 * is an open decision (see docs/00-SESSION-HANDOFF.md: their current live
 * docs describe a materially different API, OAuth2 + recipient objects,
 * than this project's existing `.env` credential shape assumes). Bank
 * account *linking* (the flow that would populate `provider_account_id` in
 * the first place) isn't built yet either.
 */
export interface PayoutRequest {
  amountKobo: number;
  recipientId: string;
  reference: string;
}

export interface PayoutResult {
  providerReference: string;
  status: 'pending' | 'processing';
}

export interface WebhookVerification {
  isValid: boolean;
  eventId: string;
  payload: unknown;
}

export interface PaymentProvider {
  readonly name: 'flutterwave' | 'paystack';
  initiateCollection(request: CollectionRequest): Promise<CollectionResult>;
  initiatePayout(request: PayoutRequest): Promise<PayoutResult>;
  verifyWebhook(rawBody: string, signatureHeader: string | null): WebhookVerification;
}
