// POST /functions/v1/create-device-pairing
//
// docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 2. Called by the
// unauthenticated web client (involveme-web's QR-pairing screen) the
// moment it loads — wraps fn_create_device_pairing. No identity exists
// yet; that's the entire point of this flow (the phone is what proves
// identity, by scanning the resulting QR code and calling
// confirm-device-pairing).
//
// Public + rate-limited (docs/19-SECURITY-HARDENING-SCOPING.md §3, same
// posture every other unauthenticated/low-cost-to-call endpoint in this
// app already has — web-send-otp is the closest template for the CORS +
// rate-limit shape).
//
// MUST be deployed with `--no-verify-jwt` (public, unauthenticated
// caller), same convention as web-send-otp/get-public-pricing/
// webhook-flutterwave:
//   supabase functions deploy create-device-pairing --use-api --no-verify-jwt

import { z } from 'npm:zod@^3.23';
import { serviceRoleClient } from '../_shared/auth.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { parseBody } from '../_shared/validate.ts';

// Per-IP only — unlike web-send-otp there's no per-phone dimension (no
// phone number is ever involved in this call at all), and the real
// security boundary downstream is device_pairings' own short expiry +
// single-use confirm, not this rate limit — this just bounds "someone
// hammers the endpoint to churn through rows."
const CREATE_PAIRING_PER_IP_MAX = 20;
const CREATE_PAIRING_PER_IP_WINDOW_SECONDS = 10 * 60;

const CreatePairingRequestSchema = z.object({
  device_label: z.string().min(1).max(200),
  platform: z.string().max(100).optional(),
});

function json(req: Request, status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

function errorResponse(req: Request, status: number, code: string, message: string): Response {
  return json(req, status, { error: code, message });
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return errorResponse(req, 405, 'method_not_allowed', 'Use POST.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(req, 400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(CreatePairingRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const { device_label, platform } = parsed.data;

  let db;
  try {
    db = serviceRoleClient();
  } catch (e) {
    console.error('create-device-pairing: serviceRoleClient() failed:', e);
    return errorResponse(req, 500, 'server_misconfigured', 'Server misconfigured.');
  }

  const remoteIp = req.headers.get('x-forwarded-for');
  if (remoteIp) {
    const allowed = await checkRateLimit(
      db,
      `create-device-pairing:ip:${remoteIp}`,
      CREATE_PAIRING_PER_IP_MAX,
      CREATE_PAIRING_PER_IP_WINDOW_SECONDS,
    );
    if (!allowed) {
      return errorResponse(req, 429, 'rate_limited', 'Too many attempts, try again later.');
    }
  }

  const { data, error } = await db
    .rpc('fn_create_device_pairing', { p_device_label: device_label, p_platform: platform ?? null })
    .single();

  if (error) {
    console.error('create-device-pairing: fn_create_device_pairing failed:', error.message);
    return errorResponse(req, 500, 'internal_error', 'Something went wrong.');
  }

  const row = data as { id: string; expires_at: string };
  return json(req, 200, { pairing_id: row.id, expires_at: row.expires_at });
});
