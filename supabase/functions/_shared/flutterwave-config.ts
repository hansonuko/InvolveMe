// _shared/flutterwave-config.ts — reads the env vars every
// Flutterwave-calling Edge Function needs into a FlutterwaveConfig, so the
// var names and defaults live in exactly one place. See
// packages/payments/flutterwave.ts for what each field is used for, and
// docs/00-SESSION-HANDOFF.md for why the credential names changed from
// FLW_PUBLIC_KEY/FLW_SECRET_KEY (v3-era naming; the values were already a
// v4 client_id/client_secret pair) to FLW_CLIENT_ID/FLW_CLIENT_SECRET.

import type { FlutterwaveConfig } from '../../../packages/payments/flutterwave.ts';

export function loadFlutterwaveConfig(): FlutterwaveConfig {
  const environment = Deno.env.get('FLW_ENVIRONMENT') ?? 'sandbox';
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`FLW_ENVIRONMENT must be "sandbox" or "production", got "${environment}"`);
  }

  return {
    clientId: Deno.env.get('FLW_CLIENT_ID') ?? '',
    clientSecret: Deno.env.get('FLW_CLIENT_SECRET') ?? '',
    environment,
    webhookSecretHash: Deno.env.get('FLW_WEBHOOK_SECRET_HASH') ?? '',
    transferSenderId: Deno.env.get('FLW_TRANSFER_SENDER_ID') ?? '',
  };
}
