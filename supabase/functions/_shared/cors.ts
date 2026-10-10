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

// involvemechat.com is the real marketing domain (live on Cloudflare as of
// 2026-10-09, docs/15-MARKETING-SITE-PWA-SCOPING.md §7); involveme-
// marketing.pages.dev is kept too since it still resolves and is the
// domain this repo's own deployed-smoke tests hit directly. web.
// involvemechat.com is the separate linked-devices companion client
// (docs/12-LINKED-DEVICES-WEB-SCOPING.md) — its QR-pairing screen calls
// create-device-pairing/get-device-pairing-status directly from browser
// JS, the same reason web-send-otp needed this file in the first place;
// involveme-web.pages.dev is kept alongside it for the same reason.
// app.involvemechat.com is docs/22-FULL-PWA-SCOPING.md's revived
// standalone app (session 45 continued) — the one domain where every
// client-callable function matters, not just the three above, since it
// mirrors the full native app's feature set in a browser.
const ALLOWED_ORIGINS = [
  'https://involvemechat.com',
  'https://www.involvemechat.com',
  'https://involveme-marketing.pages.dev',
  'https://web.involvemechat.com',
  'https://involveme-web.pages.dev',
  'https://app.involvemechat.com',
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
