// _shared/cors.ts — CORS handling for the (small) set of Edge Functions
// actually called from a browser, not just the RN app or server-to-server.
//
// Every other function in this repo is either called from apps/mobile
// (not subject to browser CORS at all) or server-side (e.g. Phase A's
// apps/marketing/lib/pricing.ts, a Next.js Server Component fetch, also
// not subject to CORS). web-send-otp is the first function actually
// invoked from client-side browser JS, so it's the first one that needs
// this. Deliberately an origin allow-list, not `Access-Control-Allow-
// Origin: *` — this endpoint fronts a real abuse surface (OTP-send), so
// only reflecting a known-good Origin back is the more conservative
// choice than a wildcard.

// involveme.net is the real domain (registered 2026-10-08, DNS not yet
// live); involveme-marketing.pages.dev is where the site actually serves
// from right now (docs/15-MARKETING-SITE-PWA-SCOPING.md §7) — both are
// listed so the live deployed signup form's own Origin header is actually
// allowed, not just the eventual production domain.
const ALLOWED_ORIGINS = [
  'https://involveme.net',
  'https://www.involveme.net',
  'https://involveme-marketing.pages.dev',
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Local dev only — any localhost/127.0.0.1 port (Next.js picks a free
  // port, e.g. 3000/3001, so this can't be a fixed single value).
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get('Origin');
  if (!isAllowedOrigin(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin as string,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

export function handlePreflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}
