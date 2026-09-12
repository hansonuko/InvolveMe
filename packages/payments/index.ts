export type {
  CollectionRequest,
  CollectionResult,
  PaymentProvider,
  PayoutRequest,
  PayoutResult,
  WebhookVerification,
} from './provider';

// Flutterwave: verifyWebhook is real; initiateCollection/initiatePayout are
// stubs pending a Flutterwave API-generation decision — see flutterwave.ts's
// header comment and docs/00-SESSION-HANDOFF.md.
export {
  createFlutterwaveProvider,
  PaymentProviderNotImplementedError,
  type FlutterwaveConfig,
} from './flutterwave';

// Paystack adapter, provisioned not wired until PAYMENTS_ACTIVE_PROVIDER flips — lands later.
