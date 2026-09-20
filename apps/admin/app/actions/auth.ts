'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignJWT, jwtVerify } from 'jose';
import { db } from '@/lib/supabase-admin';
import {
  verifyPassword,
  hashPassword,
  decryptTotpSecret,
  encryptTotpSecret,
  hashRecoveryCode,
  generateRecoveryCodes,
} from '@/lib/crypto';
import { generateTotpSecret, totpEnrollmentUri, verifyTotpToken } from '@/lib/totp';
import {
  SESSION_COOKIE_NAME,
  PENDING_COOKIE_NAME,
  signSessionToken,
  signPendingToken,
  verifyPendingToken,
} from '@/lib/session';
import { getCurrentAdmin, getRequestIp, checkPermission } from '@/lib/auth';

export type ActionState = { error: string } | { recoveryCodes: string[] } | null;

type LoginMaterial = {
  admin_user_id: string;
  password_hash: string;
  totp_secret_encrypted: string | null;
  totp_enrolled_at: string | null;
  disabled_at: string | null;
  failed_login_count: number;
  locked_until: string | null;
};

async function fetchLoginMaterial(email: string): Promise<LoginMaterial | null> {
  const { data, error } = await db().rpc('fn_admin_get_login_material', { p_email: email });
  if (error || !data || data.length === 0) return null;
  return data[0] as LoginMaterial;
}

export async function loginPasswordAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password) return { error: 'Enter an email and password.' };

  const material = await fetchLoginMaterial(email);
  const ip = await getRequestIp();

  // Constant-shape response whether or not the account exists — still run
  // a scrypt derivation against a fixed dummy hash so the response timing
  // doesn't itself leak account existence.
  const passwordOk = material
    ? await verifyPassword(password, material.password_hash)
    : await verifyPassword(password, 'scrypt$32768$00$00');

  if (!material || !passwordOk) {
    if (material) {
      await db().rpc('fn_admin_record_login_attempt', {
        p_admin_user_id: material.admin_user_id,
        p_success: false,
        p_ip: ip,
      });
    }
    return { error: 'Invalid email or password.' };
  }

  if (material.disabled_at) return { error: 'This account has been disabled.' };
  if (material.locked_until && new Date(material.locked_until) > new Date()) {
    return { error: 'Too many failed attempts. Try again later.' };
  }

  const store = await cookies();

  if (!material.totp_enrolled_at) {
    const secret = generateTotpSecret();
    const token = await signPendingTokenWithSecret(material.admin_user_id, secret);
    store.set(PENDING_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 300,
    });
    redirect('/mfa-enroll');
  }

  const token = await signPendingToken(material.admin_user_id);
  store.set(PENDING_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 300,
  });
  redirect('/mfa-verify');
}

// The pending token carries the freshly generated (not-yet-persisted) TOTP
// secret only during first-time enrollment, for the short window between
// "show the QR/secret" and "confirm the first code" — never written to the
// DB until fn_admin_enroll_mfa is actually called. jose's SignJWT is used
// directly here rather than adding a third exported function to lib/session
// for what's a one-off shape specific to this single call site.
async function signPendingTokenWithSecret(
  adminUserId: string,
  totpSecret: string,
): Promise<string> {
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw) throw new Error('ADMIN_SESSION_SECRET is not set');
  return new SignJWT({ stage: 'pending_mfa', totpSecret })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(adminUserId)
    .setIssuedAt()
    .setExpirationTime('300s')
    .sign(new TextEncoder().encode(raw));
}

async function readPendingTokenWithSecret(): Promise<{
  adminUserId: string;
  totpSecret: string;
} | null> {
  const store = await cookies();
  const token = store.get(PENDING_COOKIE_NAME)?.value;
  if (!token) return null;
  const raw = process.env.ADMIN_SESSION_SECRET;
  if (!raw) throw new Error('ADMIN_SESSION_SECRET is not set');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(raw));
    if (
      payload.stage !== 'pending_mfa' ||
      typeof payload.sub !== 'string' ||
      typeof payload.totpSecret !== 'string'
    ) {
      return null;
    }
    return { adminUserId: payload.sub, totpSecret: payload.totpSecret };
  } catch {
    return null;
  }
}

export async function getPendingEnrollment(): Promise<{
  adminUserId: string;
  secret: string;
  email: string;
  uri: string;
} | null> {
  const pending = await readPendingTokenWithSecret();
  if (!pending) return null;
  const { data } = await db()
    .from('admin_users')
    .select('email')
    .eq('id', pending.adminUserId)
    .single();
  if (!data) return null;
  return {
    adminUserId: pending.adminUserId,
    secret: pending.totpSecret,
    email: data.email,
    uri: totpEnrollmentUri(data.email, pending.totpSecret),
  };
}

export async function confirmEnrollAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const code = String(formData.get('code') ?? '').trim();
  const pending = await readPendingTokenWithSecret();
  if (!pending) return { error: 'Your session expired. Log in again.' };

  if (!verifyTotpToken(pending.totpSecret, code)) {
    return { error: 'That code is incorrect.' };
  }

  const recoveryCodes = generateRecoveryCodes();
  const hashedCodes = recoveryCodes.map(hashRecoveryCode);

  const { error } = await db().rpc('fn_admin_enroll_mfa', {
    p_admin_user_id: pending.adminUserId,
    p_totp_secret_encrypted: encryptTotpSecret(pending.totpSecret),
    p_recovery_code_hashes: hashedCodes,
  });
  if (error) return { error: 'Could not complete enrollment. Try again.' };

  await db().rpc('fn_admin_record_login_attempt', {
    p_admin_user_id: pending.adminUserId,
    p_success: true,
    p_ip: await getRequestIp(),
  });

  const store = await cookies();
  const sessionToken = await signSessionToken(pending.adminUserId);
  store.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
  store.delete(PENDING_COOKIE_NAME);

  return { recoveryCodes };
}

export async function verifyMfaAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const code = String(formData.get('code') ?? '').trim();
  const store = await cookies();
  const token = store.get(PENDING_COOKIE_NAME)?.value;
  const pending = token ? await verifyPendingToken(token) : null;
  if (!pending) return { error: 'Your session expired. Log in again.' };

  const { data: user } = await db()
    .from('admin_users')
    .select('totp_secret_encrypted')
    .eq('id', pending.adminUserId)
    .single();

  const totpSecret = user?.totp_secret_encrypted
    ? decryptTotpSecret(user.totp_secret_encrypted)
    : null;
  const totpOk = totpSecret ? verifyTotpToken(totpSecret, code) : false;
  const recoveryOk = totpOk
    ? false
    : (
        await db().rpc('fn_admin_consume_recovery_code', {
          p_admin_user_id: pending.adminUserId,
          p_code_hash: hashRecoveryCode(code),
        })
      ).data === true;

  await db().rpc('fn_admin_record_login_attempt', {
    p_admin_user_id: pending.adminUserId,
    p_success: totpOk || recoveryOk,
    p_ip: await getRequestIp(),
  });

  if (!totpOk && !recoveryOk) return { error: 'That code is incorrect.' };

  const sessionToken = await signSessionToken(pending.adminUserId);
  store.set(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
  store.delete(PENDING_COOKIE_NAME);
  redirect('/dashboard');
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE_NAME);
  store.delete(PENDING_COOKIE_NAME);
  redirect('/login');
}

export async function createAdminAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const creator = await getCurrentAdmin();
  if (!creator) return { error: 'Your session expired. Log in again.' };

  const allowed = await checkPermission(creator.id, 'manage_admin_roles');
  if (!allowed) return { error: 'You do not have permission to create admin accounts.' };

  const email = String(formData.get('email') ?? '').trim();
  const displayName = String(formData.get('display_name') ?? '').trim();
  const tempPassword = String(formData.get('temp_password') ?? '');
  const roleIds = formData.getAll('role_ids').map(String);

  if (!email || !displayName || tempPassword.length < 12) {
    return { error: 'Fill in every field — the temporary password needs at least 12 characters.' };
  }
  if (roleIds.length === 0) return { error: 'Select at least one role.' };

  const passwordHash = await hashPassword(tempPassword);
  const { error } = await db().rpc('fn_admin_create_user', {
    p_creator_admin_id: creator.id,
    p_email: email,
    p_display_name: displayName,
    p_password_hash: passwordHash,
    p_role_ids: roleIds,
  });
  if (error)
    return {
      error: error.message.includes('invalid_role_id')
        ? 'One of the selected roles is invalid.'
        : 'Could not create the admin account.',
    };

  redirect('/dashboard');
}
