// POST /functions/v1/web-send-otp
//
// The marketing site's ONLY auth-adjacent endpoint (docs/15-MARKETING-SITE-
// PWA-SCOPING.md §4) — sends a phone OTP for the homepage signup form,
// after verifying a Cloudflare Turnstile token server-side.
//
// Why this exists instead of the marketing site calling
// `supabase.auth.signInWithOtp` directly the way apps/mobile does
// (apps/mobile/app/(auth)/index.tsx): Supabase Auth's own CAPTCHA support
// (`supabase/config.toml`'s `[auth.captcha]`) is a single project-wide
// GoTrue toggle — turning it on would also gate mobile's identical calls
// to the same endpoint, which docs/15 §4 explicitly says not to do ("a new
// guard at the new entry point, not a change to the existing one"). This
// function IS that new, separate guard: it verifies Turnstile itself, then
// makes the exact same call to Supabase's `/auth/v1/otp` that
// `signInWithOtp` makes internally — GoTrue's own captcha setting stays
// off, mobile is completely unaffected.
//
// FAILS CLOSED: if TURNSTILE_SECRET_KEY isn't configured (true today —
// Cloudflare Turnstile is a new external service the user hasn't set up
// yet, same as Termii/Flutterwave were at various points), this returns
// 503 rather than silently skipping the captcha check. Never treat a
// missing secret as "captcha not required."
//
// Uses only the anon key to call GoTrue — no service_role needed, this is
// exactly what an anonymous browser client is already allowed to do.
//
// MUST be deployed with `--no-verify-jwt` (public, unauthenticated
// caller), same convention as get-public-pricing/webhook-flutterwave:
//   supabase functions deploy web-send-otp --use-api --no-verify-jwt
//
// This is also the first Edge Function in this repo actually called from
// browser JS (every other one is called from the RN app, which isn't
// subject to CORS, or server-side) — see _shared/cors.ts's header comment.

import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

function json(req: Request, status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

function errorResponse(req: Request, status: number, code: string, message: string): Response {
  return json(req, status, { error: code, message });
}

interface WebSendOtpRequestBody {
  phone?: string;
  turnstileToken?: string;
}

async function verifyTurnstile(token: string, remoteIp: string | null): Promise<boolean> {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (!secret) {
    // Caller (Deno.serve handler below) treats this distinctly from a
    // failed verification — see the 503 branch there.
    throw new Error('TURNSTILE_SECRET_KEY_NOT_SET');
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const result = await res.json();
  return result.success === true;
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return errorResponse(req, 405, 'method_not_allowed', 'Use POST.');
  }

  let payload: WebSendOtpRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(req, 400, 'invalid_request', 'Body must be valid JSON.');
  }

  const { phone, turnstileToken } = payload;
  if (typeof phone !== 'string' || !E164_PATTERN.test(phone)) {
    return errorResponse(req, 400, 'invalid_phone', 'phone must be E.164 (e.g. +2348012345678).');
  }
  if (typeof turnstileToken !== 'string' || turnstileToken.length === 0) {
    return errorResponse(req, 400, 'missing_captcha', 'turnstileToken is required.');
  }

  const remoteIp = req.headers.get('x-forwarded-for');

  let captchaOk: boolean;
  try {
    captchaOk = await verifyTurnstile(turnstileToken, remoteIp);
  } catch (e) {
    if (e instanceof Error && e.message === 'TURNSTILE_SECRET_KEY_NOT_SET') {
      console.error('web-send-otp: TURNSTILE_SECRET_KEY is not set — failing closed.');
      return errorResponse(
        req,
        503,
        'captcha_not_configured',
        'Signup is temporarily unavailable.',
      );
    }
    console.error('web-send-otp: Turnstile verification request failed:', e);
    return errorResponse(req, 503, 'captcha_unavailable', 'Could not verify captcha right now.');
  }

  if (!captchaOk) {
    return errorResponse(req, 400, 'captcha_failed', 'Captcha verification failed.');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    console.error('web-send-otp: SUPABASE_URL/SUPABASE_ANON_KEY not set.');
    return errorResponse(req, 500, 'server_misconfigured', 'Server misconfigured.');
  }

  try {
    const otpRes = await fetch(`${supabaseUrl}/auth/v1/otp`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ phone, create_user: true, channel: 'sms' }),
    });

    if (!otpRes.ok) {
      const detail = await otpRes.text().catch(() => '');
      console.error(`web-send-otp: /auth/v1/otp returned ${otpRes.status}: ${detail}`);
      // Relay GoTrue's status (e.g. 429 rate-limited) without leaking its
      // response body verbatim to an unauthenticated caller.
      return errorResponse(
        req,
        otpRes.status,
        'otp_send_failed',
        otpRes.status === 429 ? 'Too many attempts, try again later.' : 'Could not send code.',
      );
    }

    return json(req, 200, { sent: true });
  } catch (e) {
    console.error('web-send-otp: /auth/v1/otp call threw:', e);
    return errorResponse(req, 503, 'otp_send_failed', 'Could not send code right now.');
  }
});
