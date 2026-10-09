// POST /functions/v1/get-device-pairing-status
//
// docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 2. Polled by the web
// client (every ~2s, per the implementation plan — chosen over a new
// unauthenticated Realtime channel, which has no precedent anywhere in
// this repo's Broadcast-authorization model, docs/00-SESSION-HANDOFF.md
// session 44). Wraps fn_claim_device_pairing_session, which is also where
// the actual single-use delivery is enforced (row-locked, atomic) — this
// function's only extra job is minting the session token the instant that
// RPC reports 'confirmed' for the first time.
//
// Public + rate-limited, same posture as create-device-pairing. Session
// tokens are the one genuinely sensitive thing this function ever returns
// — delivered exactly once per pairing (fn_claim_device_pairing_session's
// own job), over HTTPS only, to whichever caller happens to poll at the
// right moment holding the pairing_id. That's an inherent property of
// QR-based pairing, not a new weakness introduced here — see docs/12 §2's
// own "QR replay/shoulder-surfing" note, mitigated the same way real
// WhatsApp Web accepts: a short-lived, single-use code.
//
// MUST be deployed with `--no-verify-jwt`, same as create-device-pairing:
//   supabase functions deploy get-device-pairing-status --use-api --no-verify-jwt

import { z } from 'npm:zod@^3.23';
import { serviceRoleClient } from '../_shared/auth.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';
import { signLinkedDeviceToken } from '../_shared/linkedDeviceToken.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { parseBody, requiredUuid } from '../_shared/validate.ts';

// Tighter window, higher count than create-device-pairing's — this is
// meant to be polled frequently (every ~2s) by a single legitimate
// client for up to the pairing's own ~60s expiry window, so the limit
// needs real headroom above that, not just abuse-dampening.
const POLL_PER_IP_MAX = 60;
const POLL_PER_IP_WINDOW_SECONDS = 2 * 60;

const StatusRequestSchema = z.object({
  pairing_id: requiredUuid('pairing_id'),
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

  const parsed = parseBody(StatusRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const { pairing_id } = parsed.data;

  let db;
  try {
    db = serviceRoleClient();
  } catch (e) {
    console.error('get-device-pairing-status: serviceRoleClient() failed:', e);
    return errorResponse(req, 500, 'server_misconfigured', 'Server misconfigured.');
  }

  const remoteIp = req.headers.get('x-forwarded-for');
  if (remoteIp) {
    const allowed = await checkRateLimit(
      db,
      `get-device-pairing-status:ip:${remoteIp}`,
      POLL_PER_IP_MAX,
      POLL_PER_IP_WINDOW_SECONDS,
    );
    if (!allowed) {
      return errorResponse(req, 429, 'rate_limited', 'Too many attempts, try again later.');
    }
  }

  const { data, error } = await db
    .rpc('fn_claim_device_pairing_session', { p_pairing_id: pairing_id })
    .single();

  if (error) {
    console.error(
      'get-device-pairing-status: fn_claim_device_pairing_session failed:',
      error.message,
    );
    return errorResponse(req, 500, 'internal_error', 'Something went wrong.');
  }

  const row = data as { status: string; user_id: string | null; linked_device_id: string | null };

  if (row.status === 'not_found') {
    return errorResponse(req, 404, 'pairing_not_found', 'Pairing not found.');
  }
  if (row.status === 'pending' || row.status === 'expired' || row.status === 'already_delivered') {
    return json(req, 200, { status: row.status });
  }

  // 'confirmed' — row.user_id/linked_device_id are guaranteed set here.
  let ttlSeconds: number;
  {
    const { data: ttlRow, error: ttlError } = await db
      .from('pricing_config')
      .select('value')
      .eq('key', 'linked_device_session_ttl_seconds')
      .eq('currency', 'NGN')
      .maybeSingle();
    if (ttlError || !ttlRow) {
      console.error(
        'get-device-pairing-status: linked_device_session_ttl_seconds not found:',
        ttlError?.message,
      );
      return errorResponse(req, 500, 'internal_error', 'Something went wrong.');
    }
    ttlSeconds = Number(ttlRow.value);
  }

  let accessToken: string;
  try {
    accessToken = await signLinkedDeviceToken(
      row.user_id as string,
      row.linked_device_id as string,
      ttlSeconds,
    );
  } catch (e) {
    console.error('get-device-pairing-status: signLinkedDeviceToken failed:', e);
    return errorResponse(req, 500, 'internal_error', 'Something went wrong.');
  }

  return json(req, 200, {
    status: 'confirmed',
    access_token: accessToken,
    // No real refresh token exists for a linked-device session (see
    // linked_device_session_ttl_seconds's own migration comment) — the
    // client stores this placeholder purely because supabase-js's
    // setSession() requires some string, never actually uses it to
    // refresh (confirmed live, Milestone 0).
    refresh_token: 'linked-device-no-refresh',
  });
});
