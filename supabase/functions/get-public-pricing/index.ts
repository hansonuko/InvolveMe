// GET /functions/v1/get-public-pricing
//
// Public, unauthenticated read of a small, explicit whitelist of
// `pricing_config` keys — built for the marketing site (docs/15
// §2/§7: "pricing_config values, fetched at build/deploy time or via a
// public read-only endpoint — never hand-copied numbers that go stale").
// `pricing_config` itself stays `authenticated`-only per its RLS policy
// (supabase/migrations/20260912072749_rls_policies.sql) — this function
// does not loosen that. It reads via service_role and returns only the 6
// keys below, never the full row set (no withdrawal/KYC-cap internals).
// platform_earning_take_bps added so the site can show a real "what you
// earn per reply" figure (the earn-first repositioning), not just what a
// sender pays — same non-sensitive-numeric-config category as the rest.
//
// MUST be deployed with `--no-verify-jwt`, same as webhook-flutterwave and
// reconcile-topups — see webhook-flutterwave/index.ts's header for the
// real 2026-09-13 incident that makes this non-optional:
//   supabase functions deploy get-public-pricing --use-api --no-verify-jwt

import { serviceRoleClient } from '../_shared/auth.ts';

const PUBLIC_KEYS = [
  'credit_unit_kobo',
  'message_base_credits',
  'message_word_block_size',
  'message_max_words',
  'platform_topup_fee_bps',
  'platform_earning_take_bps',
] as const;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // Static-ish config, safe to cache at the edge/CDN for a while —
      // the marketing site's own ISR (revalidate: 3600) is the primary
      // freshness mechanism, this is just a secondary cache-friendliness
      // signal for anything sitting in front of this function.
      'Cache-Control': 'public, max-age=300',
    },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

Deno.serve(async (req) => {
  if (req.method !== 'GET') {
    return errorResponse(405, 'method_not_allowed', 'Use GET.');
  }

  const db = serviceRoleClient();
  const { data, error } = await db
    .from('pricing_config')
    .select('key, value')
    .in('key', PUBLIC_KEYS);

  if (error) {
    console.error('get-public-pricing: pricing_config select failed:', error.message);
    return errorResponse(500, 'internal_error', 'Could not load pricing right now.');
  }

  const byKey = new Map(data?.map((row) => [row.key, Number(row.value)]) ?? []);
  const missing = PUBLIC_KEYS.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    // Shouldn't happen outside a broken seed/migration — fail loudly rather
    // than serve partial/undefined pricing figures on a public page.
    console.error('get-public-pricing: missing expected pricing_config keys:', missing);
    return errorResponse(500, 'internal_error', 'Pricing configuration incomplete.');
  }

  return json(200, Object.fromEntries(PUBLIC_KEYS.map((key) => [key, byKey.get(key)])));
});
