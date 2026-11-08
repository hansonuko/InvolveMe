// POST /functions/v1/web-send-otp
//
// The marketing site's ONLY auth-adjacent endpoint (docs/15-MARKETING-SITE-
// PWA-SCOPING.md §4) — sends an email OTP for the homepage signup form,
// after verifying a Cloudflare Turnstile token server-side.
//
// Email, not phone (2026-11-08): phone-number signup is deferred to a
// future pass — SMS delivery isn't reliably wired up yet, while email OTP
// works out of the box via GoTrue's own mailer. The prelaunch date gate
// that used to sit here (waiting for November 20) is gone too — signup is
// open now.
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
// FAILS CLOSED: if TURNSTILE_SECRET_KEY isn't configured, this returns 503
// rather than silently skipping the captcha check. Never treat a missing
// secret as "captcha not required."
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

import { z } from 'npm:zod@^3.23';
import { serviceRoleClient } from '../_shared/auth.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';

// docs/19-SECURITY-HARDENING-SCOPING.md §3 — this function's own header
// comment already flagged the absence of this as a real gap (OTP-bombing a
// single address, or hammering the endpoint generally) before it was
// closed. Two dimensions: per-email (the actual abuse target) tighter than
// per-IP (a shared NAT/office network legitimately sends more than one
// signup).
const OTP_PER_EMAIL_MAX = 3;
const OTP_PER_EMAIL_WINDOW_SECONDS = 10 * 60;
const OTP_PER_IP_MAX = 10;
const OTP_PER_IP_WINDOW_SECONDS = 10 * 60;

// Kept as two separately-parsed fields, not one parseBody() call
// (docs/19-SECURITY-HARDENING-SCOPING.md §4's shared helper), because this
// function's contract already distinguishes invalid_email from
// missing_captcha as separate error codes — a client-visible distinction
// (see web-send-otp-function.test.js), not an implementation detail to
// collapse into one generic invalid_request just for consistency.
const EmailSchema = z.string().email();
const TurnstileTokenSchema = z.string().min(1);

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
  email?: string;
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

  const { email: rawEmail, turnstileToken: rawTurnstileToken } = payload;
  const emailParsed = EmailSchema.safeParse(rawEmail);
  if (!emailParsed.success) {
    return errorResponse(req, 400, 'invalid_email', 'email must be a valid email address.');
  }
  const email = emailParsed.data;
  const turnstileParsed = TurnstileTokenSchema.safeParse(rawTurnstileToken);
  if (!turnstileParsed.success) {
    return errorResponse(req, 400, 'missing_captcha', 'turnstileToken is required.');
  }
  const turnstileToken = turnstileParsed.data;

  const remoteIp = req.headers.get('x-forwarded-for');

  let db;
  try {
    db = serviceRoleClient();
  } catch (e) {
    console.error('web-send-otp: serviceRoleClient() failed:', e);
    return errorResponse(req, 500, 'server_misconfigured', 'Server misconfigured.');
  }

  const emailAllowed = await checkRateLimit(
    db,
    `web-send-otp:email:${email}`,
    OTP_PER_EMAIL_MAX,
    OTP_PER_EMAIL_WINDOW_SECONDS,
  );
  if (!emailAllowed) {
    return errorResponse(
      req,
      429,
      'rate_limited',
      'Too many attempts for this email, try again later.',
    );
  }
  if (remoteIp) {
    const ipAllowed = await checkRateLimit(
      db,
      `web-send-otp:ip:${remoteIp}`,
      OTP_PER_IP_MAX,
      OTP_PER_IP_WINDOW_SECONDS,
    );
    if (!ipAllowed) {
      return errorResponse(req, 429, 'rate_limited', 'Too many attempts, try again later.');
    }
  }

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
      body: JSON.stringify({ email, create_user: true }),
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
