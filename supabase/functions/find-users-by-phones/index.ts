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
// Batch enumeration risk — bounded two ways: the per-call size cap below
// (unchanged), plus a per-caller rate limit on how often this whole
// function can be called at all (docs/19-SECURITY-HARDENING-SCOPING.md §3,
// the "new shared infra" this file's own comment used to say didn't exist
// yet — fn_check_rate_limit now does). A phonebook sync is a rare,
// once-in-a-while action, not a per-minute one, so this is deliberately a
// tighter/longer window than find-user-by-phone's single-lookup limit.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { parseBody } from '../_shared/validate.ts';

const SYNC_MAX = 5;
const SYNC_WINDOW_SECONDS = 60 * 60;

// The batch-size cap (below) is checked separately, after this parse, so it
// can keep its own distinct too_many_phones error code rather than being
// collapsed into invalid_request — same "don't merge a client-visible
// distinction into one generic code" reasoning web-send-otp's schema
// comment gives.
const NON_EMPTY_ARRAY_MSG = 'phones must be a non-empty array.';
const EVERY_ENTRY_MSG = 'Every entry in phones must be a non-empty string.';

const FindUsersByPhonesRequestSchema = z.object({
  phones: z
    .array(
      z
        .string({ required_error: EVERY_ENTRY_MSG, invalid_type_error: EVERY_ENTRY_MSG })
        .trim()
        .min(1, EVERY_ENTRY_MSG),
      { required_error: NON_EMPTY_ARRAY_MSG, invalid_type_error: NON_EMPTY_ARRAY_MSG },
    )
    .min(1, NON_EMPTY_ARRAY_MSG),
});

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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(FindUsersByPhonesRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  if (payload.phones.length > MAX_PHONES_PER_CALL) {
    return errorResponse(
      400,
      'too_many_phones',
      `phones must contain at most ${MAX_PHONES_PER_CALL} entries.`,
    );
  }

  const db = serviceRoleClient();

  const allowed = await checkRateLimit(
    db,
    `find-users-by-phones:user:${user.id}`,
    SYNC_MAX,
    SYNC_WINDOW_SECONDS,
  );
  if (!allowed) {
    return errorResponse(429, 'rate_limited', 'Too many sync attempts, try again later.');
  }

  // Same leading-"+" strip find-user-by-phone documents — Supabase Auth
  // stores phone numbers without it.
  const normalizedPhones = [...new Set(payload.phones.map((p) => p.replace(/^\+/, '')))];

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
