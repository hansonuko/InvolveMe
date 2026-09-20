import 'server-only';
import { cookies, headers } from 'next/headers';
import { db } from '@/lib/supabase-admin';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/session';

export type CurrentAdmin = {
  id: string;
  email: string;
  displayName: string;
};

// Every Server Action re-derives the current admin from the session cookie
// itself rather than trusting a value passed in from the client — the
// middleware gate covers page navigation, but a Server Action can be
// invoked directly, so this is the real check (docs/14 §7.2).
export async function getCurrentAdmin(): Promise<CurrentAdmin | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await verifySessionToken(token);
  if (!session) return null;

  const { data, error } = await db()
    .from('admin_users')
    .select('id, email, display_name, disabled_at')
    .eq('id', session.adminUserId)
    .single();

  if (error || !data || data.disabled_at) return null;

  return { id: data.id, email: data.email, displayName: data.display_name };
}

export async function requireCurrentAdmin(): Promise<CurrentAdmin> {
  const admin = await getCurrentAdmin();
  if (!admin) throw new Error('not_authenticated');
  return admin;
}

export async function checkPermission(adminUserId: string, permission: string): Promise<boolean> {
  const { data, error } = await db().rpc('fn_admin_check_permission', {
    p_admin_user_id: adminUserId,
    p_permission: permission,
  });
  if (error) return false;
  return data === true;
}

export async function getRequestIp(): Promise<string | null> {
  const store = await headers();
  // Trusted only insofar as the deployment sits behind Netlify's own edge,
  // which sets this header itself — not attacker-controlled input arriving
  // straight from a client TCP connection.
  return store.get('x-nf-client-connection-ip') ?? store.get('x-forwarded-for') ?? null;
}
