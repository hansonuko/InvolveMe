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

export interface PayoutRequest {
  amountKobo: number;
  accountNumber: string;
  bankCode: string;
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
