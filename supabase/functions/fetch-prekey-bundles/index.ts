// POST /functions/v1/fetch-prekey-bundles
//
// Real end-to-end encryption, step 2 (docs/21-E2EE-TECHNICAL-DESIGN.md §3)
// — wraps fn_fetch_prekey_bundles, the X3DH handshake's read path. Returns
// one bundle per active device the target user has (fn_fetch_prekey_
// bundles itself enforces the caller/target-share-a-thread gate — the same
// anti-enumeration posture find-user-by-phone/users_select_own_or_
// thread_partner already establish elsewhere in this app, not a new
// lookup surface).
//
// Rate-limited per caller (docs/19-SECURITY-HARDENING-SCOPING.md §3's
// discipline, applied here for a new reason: repeatedly calling this
// against the same target atomically consumes one of THEIR one-time
// prekeys per call, even without ever completing a real handshake —
// unbounded calls would let one caller drain a target's entire pool,
// forcing every future real handshake with that target into X3DH's
// degraded (no one-time-prekey) mode. The cap is generous for legitimate
// use (starting E2EE with a handful of threads) while bounding that drain.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { parseBody, requiredUuid } from '../_shared/validate.ts';

const FETCH_BUNDLES_MAX = 20;
const FETCH_BUNDLES_WINDOW_SECONDS = 60;

const FetchPrekeyBundlesRequestSchema = z.object({
  target_user_id: requiredUuid('target_user_id'),
});

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

function mapFetchBundlesError(pgMessage: string): Response {
  if (pgMessage.startsWith('cannot_fetch_own_bundle')) {
    return errorResponse(400, 'invalid_request', "You can't fetch your own bundle.");
  }
  if (pgMessage.startsWith('not_a_thread_partner')) {
    return errorResponse(403, 'not_a_thread_partner', 'You have no thread with this user.');
  }
  console.error('fetch-prekey-bundles: unmapped DB error:', pgMessage);
  return errorResponse(500, 'internal_error', 'Something went wrong.');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('fetch-prekey-bundles: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(FetchPrekeyBundlesRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();

  const allowed = await checkRateLimit(
    db,
    `fetch-prekey-bundles:user:${user.id}`,
    FETCH_BUNDLES_MAX,
    FETCH_BUNDLES_WINDOW_SECONDS,
  );
  if (!allowed) {
    return errorResponse(429, 'rate_limited', 'Too many handshake attempts, try again shortly.');
  }

  const { data: bundles, error } = await db.rpc('fn_fetch_prekey_bundles', {
    p_caller_id: user.id,
    p_target_user_id: payload.target_user_id,
  });

  if (error) {
    return mapFetchBundlesError(error.message);
  }

  return json(200, { bundles: bundles ?? [] });
});
