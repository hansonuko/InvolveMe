// POST /functions/v1/complete-onboarding
//
// E2 (docs/10-UX-REFINEMENT-BACKLOG.md Batch E) — one-time first-signup
// onboarding write: country -> full name -> nickname -> currency
// auto-detect. Wraps fn_complete_onboarding (migration
// 20260917130000_multicurrency_schema.sql) — same "identity is re-derived
// from the caller's JWT, never trusted from the request body" posture every
// other function here uses, via _shared/auth.ts, same shape as
// mark-status-viewed/set-thread-muted.
//
// fn_complete_onboarding itself resolves currency from
// country_currency_config rather than trusting a client-supplied currency —
// a country whose payments_live is still false resolves to 'NGN' (the
// honest "not supported yet for payments" fallback), never a client-claimed
// currency for a rail that doesn't actually exist yet (docs/03-ECONOMY-LEDGER.md
// §12). This function surfaces that resolution back to the client so the
// welcome screen can render the right message.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface CompleteOnboardingRequestBody {
  country?: string;
  display_name?: string;
  nickname?: string;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
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
    console.error('complete-onboarding: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: CompleteOnboardingRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const country = payload.country?.trim().toUpperCase();
  const displayName = payload.display_name?.trim();
  const nickname = payload.nickname?.trim();

  if (!country || country.length !== 2) {
    return errorResponse(400, 'invalid_request', 'country must be a 2-letter ISO country code.');
  }
  if (!displayName) {
    return errorResponse(400, 'invalid_request', 'display_name is required.');
  }
  if (!nickname) {
    return errorResponse(400, 'invalid_request', 'nickname is required.');
  }

  const db = serviceRoleClient();
  const { data, error } = await db
    .rpc('fn_complete_onboarding', {
      p_user_id: user.id,
      p_country: country,
      p_display_name: displayName,
      p_nickname: nickname,
    })
    .single();

  if (error) {
    const message = error.message ?? '';
    if (message.includes('unknown country code')) {
      return errorResponse(400, 'unknown_country', 'Unknown country code.');
    }
    if (message.includes('already completed')) {
      return errorResponse(409, 'already_onboarded', 'Onboarding was already completed.');
    }
    console.error('complete-onboarding: fn_complete_onboarding failed:', message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, {
    currency: (data as { resolved_currency: string; payments_live: boolean }).resolved_currency,
    payments_live: (data as { resolved_currency: string; payments_live: boolean }).payments_live,
  });
});
