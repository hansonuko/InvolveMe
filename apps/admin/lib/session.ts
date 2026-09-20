// Pure JWT sign/verify — no Next.js cookie APIs here, so this module works
// identically in middleware (edge runtime, NextRequest/NextResponse
// cookies) and in Server Actions (Node runtime, next/headers cookies()).
// jose is used specifically because it runs in both runtimes; Node's own
// crypto module (used elsewhere in apps/admin/lib) does not run on the
// edge runtime middleware executes in.

import { SignJWT, jwtVerify } from 'jose';

export const SESSION_COOKIE_NAME = 'admin_session';
export const PENDING_COOKIE_NAME = 'admin_pending';

const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h — short-lived per docs/14 §7.5
const PENDING_TTL_SECONDS = 5 * 60; // 5 minutes to complete the MFA step after password check

function getSecret(): Uint8Array {
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw) throw new Error('ADMIN_SESSION_SECRET is not set');
  return new TextEncoder().encode(raw);
}

export async function signSessionToken(adminUserId: string): Promise<string> {
  return new SignJWT({ stage: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(adminUserId)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<{ adminUserId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.stage !== 'authenticated' || typeof payload.sub !== 'string') return null;
    return { adminUserId: payload.sub };
  } catch {
    return null;
  }
}

export async function signPendingToken(adminUserId: string): Promise<string> {
  return new SignJWT({ stage: 'pending_mfa' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(adminUserId)
    .setIssuedAt()
    .setExpirationTime(`${PENDING_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyPendingToken(token: string): Promise<{ adminUserId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.stage !== 'pending_mfa' || typeof payload.sub !== 'string') return null;
    return { adminUserId: payload.sub };
  } catch {
    return null;
  }
}
