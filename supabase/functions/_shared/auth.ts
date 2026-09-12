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
 * Verifies the Authorization header's JWT against Supabase Auth and returns
 * the authenticated user. Throws AuthError (401) on a missing, invalid, or
 * expired token.
 */
export async function requireAuthenticatedUser(req: Request): Promise<User> {
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
