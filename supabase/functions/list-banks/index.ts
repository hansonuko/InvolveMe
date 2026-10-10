// GET /functions/v1/list-banks
//
// Read-only reference data (Nigerian bank names/codes) for the
// link-bank-account UI's bank picker — routed through
// PaymentProvider.listBanks() rather than a hardcoded list, since
// Flutterwave is the source of truth for which bank_code values
// resolve-bank-account-name and create-transfer-recipient will actually
// accept. Auth-gated (not because the data itself is sensitive, just to
// stay consistent with every other function here requiring a session)
// but doesn't need KYC tier — a user picking a bank before they've
// verified identity is a normal order to do things in.

import { AuthError, requireAuthenticatedUser } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return errorResponse(405, 'method_not_allowed', 'Use GET.');
  }

  try {
    await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('list-banks: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());

  try {
    const banks = await provider.listBanks();
    return json(200, { banks });
  } catch (e) {
    console.error('list-banks: provider.listBanks failed:', e);
    return errorResponse(
      503,
      'payment_provider_unavailable',
      'Could not load the bank list right now.',
    );
  }
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const res = await handleRequest(req);
  const extra = corsHeaders(req);
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});
