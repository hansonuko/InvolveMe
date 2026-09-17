// POST /functions/v1/find-users-by-phones
//
// Batch counterpart to find-user-by-phone, for the device-contacts sync
// flow (docs/10-UX-REFINEMENT-BACKLOG.md Batch C1): syncing a whole
// phonebook one number at a time would be N round trips and N separate
// opportunities to leak "this number exists / doesn't exist" timing —
// one call, one query, one response.
//
// Same "no financial logic, no SECURITY DEFINER function needed" posture
// as find-user-by-phone: this is a plain read via the service-role client,
// same auth/normalization pattern as that function.
//
// Batch enumeration risk, deliberately not solved beyond a size cap here:
// this is a strictly larger version of find-user-by-phone's own documented
// "known gap, not addressed here" (phone enumeration via automation) —
// uploading an entire phonebook in one call is the intended use case, but
// it's also a bigger single-request scraping surface than the one-number
// version. Capping the batch size (below) bounds the damage per call and
// keeps the query cheap; real rate-limiting (e.g. calls-per-user-per-day)
// would need new shared infra this app doesn't have yet for any
// non-domain-specific action — flagged here the same way the single-lookup
// version flags its own gap, not solved as a side effect of this function.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface FindUsersByPhonesRequestBody {
  phones?: string[];
}

interface MatchedUser {
  phone: string;
  id: string;
  display_name: string | null;
  avatar_url: string | null;
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

// A real device phonebook rarely exceeds a few hundred entries — this caps
// the query size per call generously above that, not tightly against it.
const MAX_PHONES_PER_CALL = 2000;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('find-users-by-phones: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: FindUsersByPhonesRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (!Array.isArray(payload.phones) || payload.phones.length === 0) {
    return errorResponse(400, 'invalid_request', 'phones must be a non-empty array.');
  }
  if (payload.phones.length > MAX_PHONES_PER_CALL) {
    return errorResponse(
      400,
      'too_many_phones',
      `phones must contain at most ${MAX_PHONES_PER_CALL} entries.`,
    );
  }
  if (!payload.phones.every((p) => typeof p === 'string' && p.trim().length > 0)) {
    return errorResponse(
      400,
      'invalid_request',
      'Every entry in phones must be a non-empty string.',
    );
  }

  // Same leading-"+" strip find-user-by-phone documents — Supabase Auth
  // stores phone numbers without it.
  const normalizedPhones = [...new Set(payload.phones.map((p) => p.replace(/^\+/, '')))];

  const db = serviceRoleClient();

  const { data: found, error } = await db
    .from('users')
    .select('id, phone, display_name, avatar_url')
    .in('phone', normalizedPhones);

  if (error) {
    console.error('find-users-by-phones: lookup failed:', error.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  // Never echo the caller's own contact-list entry for themselves back as
  // a "match" — same self-exclusion find-user-by-phone enforces, just
  // silently dropped here instead of erroring out the whole batch over it.
  const matches: MatchedUser[] = (found ?? [])
    .filter((row) => row.id !== user.id)
    .map((row) => ({
      phone: row.phone,
      id: row.id,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    }));

  return json(200, { matches });
});
