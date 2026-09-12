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

/**
 * `providerCustomerId` — always a pre-resolved id (see
 * `PaymentProvider.resolveCustomerId` below), never created inline here.
 * Split into its own step deliberately: this session's live testing found
 * that folding customer-creation into `initiateCollection` meant a customer
 * could be created successfully at Flutterwave but never persisted to
 * `users.provider_customer_id` if a *later* step in the same call failed —
 * the next attempt then tried to create a second customer with the same
 * (synthetic, stable-per-user) email and got a real 409
 * `CUSTOMER_ALREADY_EXISTS`, with no way to recover the first id (v4 has no
 * get-customer-by-email lookup). Resolving and persisting the customer id
 * as its own step, before ever attempting a collection, removes that
 * failure mode instead of working around its symptom.
 */
export interface CollectionRequest {
  amountKobo: number;
  providerCustomerId: string;
  reference: string;
}

export interface ResolveCustomerRequest {
  email: string;
  name?: string;
  phone?: string;
}

/**
 * No `checkoutUrl` — Flutterwave v4's collection model (see
 * flutterwave.ts's header comment) has no single hosted-checkout-link call.
 * `instructions` covers the one method actually implemented (NGN bank
 * transfer via a dynamic virtual account — no BVN/NIN required, confirmed
 * live, and no card tokenization either, so no PCI scope in the mobile app
 * — see docs/03-ECONOMY-LEDGER.md's "stay lite" guidance). A card/redirect
 * method would add a `redirectUrl` field here later, not replace this shape.
 */
export interface CollectionResult {
  providerReference: string;
  instructions: {
    type: 'bank_transfer';
    accountNumber: string;
    bankName: string | null;
    accountName: string | null;
    expiresAt: string | null;
  };
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
 * against the old shape yet. Confirmed against Flutterwave v4's live docs:
 * `recipientId` maps to a `/transfers/recipients` id, created via a
 * separate bank-account-linking flow that isn't built yet (see
 * docs/00-SESSION-HANDOFF.md) — every `bank_accounts` row usable by
 * `withdraw` today is still a manually-inserted test fixture.
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
  /**
   * Idempotent from the caller's point of view only if the caller persists
   * the result before calling this again for the same identity — the
   * provider itself has no create-or-reuse semantics (a second call with
   * the same email is a real 409, not a safe no-op). See
   * `CollectionRequest`'s comment for why this is split out.
   */
  resolveCustomerId(request: ResolveCustomerRequest): Promise<string>;
  initiateCollection(request: CollectionRequest): Promise<CollectionResult>;
  initiatePayout(request: PayoutRequest): Promise<PayoutResult>;
  verifyWebhook(rawBody: string, signatureHeader: string | null): WebhookVerification;
}
