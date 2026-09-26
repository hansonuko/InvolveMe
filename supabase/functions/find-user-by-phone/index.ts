// POST /functions/v1/find-user-by-phone
//
// New this session, not in the original function set — a real gap found
// while wiring up the mobile chat UI to send-message: `send-message` takes
// a `recipient_id` (uuid), but nothing anywhere resolves a phone number to
// one. Direct client reads can't fill this gap either —
// `users_select_own_or_thread_partner` (see the RLS migration) correctly
// only lets a user read their own row or an existing thread partner's, not
// an arbitrary stranger's, so "look someone up to start a new chat" has to
// be a narrow, purpose-built server-side lookup rather than a relaxed RLS
// policy.
//
// Returns only what a "start a chat with this person" UI needs (id,
// display_name, avatar_url) — never the full row, and never the phone
// number back (the caller already has whatever they typed). No financial
// logic, no balance mutation, so this doesn't need a SECURITY DEFINER DB
// function per CLAUDE.md rule #1 — it's a read, done via the service-role
// client the same way every other Edge Function's non-money reads/writes
// already are (e.g. buy-credit's users/topups lookups).
//
// Rate-limited per caller (docs/19-SECURITY-HARDENING-SCOPING.md §3) — this
// was flagged above as a phone-enumeration surface with no rate limiting
// beyond Supabase's generic platform-level limits; closed by capping how
// fast one caller can probe numbers, complementing (not replacing)
// docs/18 §A4's exact-match-only anti-enumeration property.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { parseBody } from '../_shared/validate.ts';

const LOOKUP_MAX = 30;
const LOOKUP_WINDOW_SECONDS = 60;

const FindUserByPhoneRequestSchema = z.object({
  phone: z
    .string({ invalid_type_error: 'phone is required.', required_error: 'phone is required.' })
    .trim()
    .min(1, 'phone is required.'),
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('find-user-by-phone: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(FindUserByPhoneRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();

  const allowed = await checkRateLimit(
    db,
    `find-user-by-phone:user:${user.id}`,
    LOOKUP_MAX,
    LOOKUP_WINDOW_SECONDS,
  );
  if (!allowed) {
    return errorResponse(429, 'rate_limited', 'Too many lookups, try again in a minute.');
  }

  // Supabase Auth strips the leading "+" before storing a phone number
  // (confirmed by creating a real test user and inspecting the row) — the
  // client sends E.164 with a "+" (same value it uses for signInWithOtp),
  // so this has to match users.phone's actual on-disk format or every
  // lookup 404s, including a user looking up their own number.
  const normalizedPhone = payload.phone.replace(/^\+/, '');

  const { data: found, error } = await db
    .from('users')
    .select('id, display_name, avatar_url')
    .eq('phone', normalizedPhone)
    .maybeSingle();

  if (error) {
    console.error('find-user-by-phone: lookup failed:', error.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  if (!found) {
    return errorResponse(404, 'user_not_found', 'No InvolveMe user has that phone number.');
  }

  if (found.id === user.id) {
    return errorResponse(400, 'invalid_request', "That's your own number.");
  }

  return json(200, {
    id: found.id,
    display_name: found.display_name,
    avatar_url: found.avatar_url,
  });
});
