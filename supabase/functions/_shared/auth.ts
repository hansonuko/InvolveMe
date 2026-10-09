// _shared/auth.ts — JWT verification helper for Edge Functions.
//
// Every Edge Function that touches money uses this first, per CLAUDE.md
// rule #1: financial logic never trusts a client-supplied user id, so
// identity is always re-derived here from the caller's own JWT, never read
// out of the request body.
//
// The SECURITY DEFINER functions in supabase/migrations are locked to
// service_role (see 20260912072753_security_definer_functions.sql's header
// comment) precisely because they trust their arguments rather than calling
// auth.uid() themselves — this module is the layer responsible for making
// sure the id passed as p_sender_id/p_user_id downstream actually is the
// authenticated caller.
//
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are reserved
// env var names the Edge Runtime injects automatically (both hosted and via
// `supabase functions serve`, pointed at whichever project is linked) — not
// read from a .env file passed with --env-file, which cannot override them.

import { createClient, type User } from 'npm:@supabase/supabase-js@2';

export class AuthError extends Error {
  status: number;
  code: string;

  constructor(code: string, status: number, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

/**
 * Reads the `linked_device_id` claim out of a bearer JWT's own payload,
 * without re-verifying its signature — by the point this runs, the token
 * has already passed `client.auth.getUser()` in this same request, so its
 * validity is already established; this is purely an extra-claim read.
 * `_shared/linkedDeviceToken.ts`'s own header comment has the full story
 * on why this claim exists at all (docs/12-LINKED-DEVICES-WEB-SCOPING.md
 * Milestone 0): a linked (companion) device's session is a stateless,
 * self-signed token with no backing `auth.sessions` row, so there's no
 * native session id to check against — this app's own claim is the only
 * signal that distinguishes it from a real phone session, which never
 * carries it at all. Returns null for a malformed token rather than
 * throwing — that's `client.auth.getUser()`'s job above, not this one's.
 */
function decodeLinkedDeviceId(authHeader: string): string | null {
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const payload = JSON.parse(json);
    return typeof payload.linked_device_id === 'string' ? payload.linked_device_id : null;
  } catch {
    return null;
  }
}

/**
 * Verifies the Authorization header's JWT against Supabase Auth and returns
 * the authenticated user. Throws AuthError (401) on a missing, invalid, or
 * expired token.
 *
 * `blockLinkedDevices: true` additionally throws AuthError (403,
 * `linked_device_restricted`) if the caller is a linked/companion session
 * — docs/12-LINKED-DEVICES-WEB-SCOPING.md §4's "ship linked-device
 * sessions as chat-and-status only, no exceptions" restriction,
 * unconditional on the device's current revoked_at status (this blocks
 * every linked session from ever reaching a wallet action, not just
 * already-revoked ones — revocation is a separate, broader concern this
 * flag doesn't address). An explicit opt-in on each call site that needs
 * it, not a new default for every one of this function's existing
 * callers, and co-located with the identity check itself rather than a
 * second call a wallet function could forget to add.
 */
export async function requireAuthenticatedUser(
  req: Request,
  options?: { blockLinkedDevices?: boolean },
): Promise<User> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    throw new AuthError('unauthorized', 401, 'Missing Authorization header.');
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    throw new AuthError('server_misconfigured', 500, 'Supabase URL/anon key not set.');
  }

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) {
    throw new AuthError('unauthorized', 401, 'Invalid or expired token.');
  }

  if (options?.blockLinkedDevices && decodeLinkedDeviceId(authHeader) !== null) {
    throw new AuthError(
      'linked_device_restricted',
      403,
      'This action is not available from a linked device — use your primary phone.',
    );
  }

  return data.user;
}

/**
 * Service-role client for calling the SECURITY DEFINER RPCs that are
 * locked to service_role — an authenticated user's own client can never
 * call these directly (see the migration's REVOKE/GRANT block).
 */
export function serviceRoleClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new AuthError('server_misconfigured', 500, 'Service role key not set.');
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}
