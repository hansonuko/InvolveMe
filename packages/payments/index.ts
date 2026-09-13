export type {
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
} from './provider';

// Flutterwave: real live-v4 implementation, not a stub — see
// flutterwave.ts's own header comment for what's confirmed live vs. still
// assumed, and docs/00-SESSION-HANDOFF.md for the research trail.
export {
  createFlutterwaveProvider,
  PaymentProviderError,
  type FlutterwaveConfig,
} from './flutterwave';

// Paystack adapter, provisioned not wired until PAYMENTS_ACTIVE_PROVIDER flips — lands later.
