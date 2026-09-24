import 'server-only';
import type { FlutterwaveConfig } from '@involveme/payments';

// Mirrors supabase/functions/_shared/flutterwave-config.ts's env var names
// exactly, so both places stay in sync by naming convention alone — this
// app never receives an inbound webhook (only webhook-flutterwave does),
// so FLW_WEBHOOK_SECRET_HASH is deliberately not read here; initiatePayout
// is the only PaymentProvider method this app ever calls (Phase F piece 3,
// docs/14-ADMIN-DASHBOARD-SCOPING.md §5), and it doesn't need that field.
export function loadFlutterwaveConfig(): FlutterwaveConfig {
  const environment = process.env.FLW_ENVIRONMENT ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`FLW_ENVIRONMENT must be "sandbox" or "production", got "${environment}"`);
  }

  return {
    clientId: process.env.FLW_CLIENT_ID ?? '',
    clientSecret: process.env.FLW_CLIENT_SECRET ?? '',
    environment,
    webhookSecretHash: '',
    transferSenderId: process.env.FLW_TRANSFER_SENDER_ID ?? '',
  };
}
