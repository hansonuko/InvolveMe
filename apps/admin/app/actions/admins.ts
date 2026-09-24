'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase-admin';
import { getCurrentAdmin } from '@/lib/auth';

async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');
  return admin;
}

export type AdminActionState = { error: string } | null;

// Not dual-approval-gated — see the migration's own header
// (20260926100000_admin_account_management_functions.sql) for why role
// (re)assignment stays outside the pending-actions framework while account
// status changes below don't: only "disabling another admin" is named in
// docs/14 §4.4's materiality list, and only manage_admin_roles (today,
// only super_admin) can call this at all.
export async function setAdminRolesAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const targetAdminId = String(formData.get('target_admin_id') ?? '');
  const roleIds = formData.getAll('role_id').map(String).filter(Boolean);
  if (!targetAdminId) return { error: 'Invalid request.' };

  const { error } = await db().rpc('fn_admin_set_admin_roles', {
    p_actor_admin_id: admin.id,
    p_target_admin_id: targetAdminId,
    p_role_ids: roleIds,
  });
  if (error) {
    return {
      error: error.message.includes('cannot_change_own_roles')
        ? 'You cannot change your own roles — ask another admin with Manage admins.'
        : error.message.includes('not_authorized')
          ? 'You do not have permission to do that.'
          : error.message.includes('invalid_role_id')
            ? 'One of those roles no longer exists.'
            : error.message.includes('admin_user_not_found')
              ? 'That admin account no longer exists.'
              : 'Could not update roles.',
    };
  }

  redirect('/dashboard/admins');
}

// docs/14 §8.1 point 3's recovery path, built since Phase A
// (fn_admin_reset_mfa) but never wired to any UI until this piece —
// enforced server-side already (a different admin, not the target).
export async function resetAdminMfaAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const targetAdminId = String(formData.get('target_admin_id') ?? '');
  if (!targetAdminId) return { error: 'Invalid request.' };

  const { error } = await db().rpc('fn_admin_reset_mfa', {
    p_actor_admin_id: admin.id,
    p_target_admin_id: targetAdminId,
  });
  if (error) {
    return {
      error: error.message.includes('cannot_reset_own_mfa')
        ? 'You cannot reset your own MFA — ask another admin with Manage admins.'
        : error.message.includes('not_authorized')
          ? 'You do not have permission to do that.'
          : error.message.includes('admin_user_not_found')
            ? 'That admin account no longer exists.'
            : 'Could not reset MFA.',
    };
  }

  redirect('/dashboard/admins');
}

// docs/14 §4.4 names "disabling another admin" explicitly as a materially
// risky action requiring dual approval — this proposes either direction
// (see the migration's header for why reactivation gets the same
// treatment even though the doc only names disabling). Self-target is
// deliberately allowed here (e.g. proposing to disable your own
// suspected-compromised account) — the safety property comes entirely
// from requiring a different admin's approval, same as every other
// dual-approved action in this codebase.
export async function proposeAdminAccountStatusChangeAction(
  _prev: AdminActionState,
  formData: FormData,
): Promise<AdminActionState> {
  const admin = await requireAdmin();
  const targetAdminId = String(formData.get('target_admin_id') ?? '');
  const disable = formData.get('disable') === 'true';
  if (!targetAdminId) return { error: 'Invalid request.' };

  const { error } = await db().rpc('fn_admin_propose_pending_action', {
    p_actor_admin_id: admin.id,
    p_action_type: 'admin_account_status_change',
    p_payload: { target_admin_id: targetAdminId, disable },
  });
  if (error) {
    return {
      error: error.message.includes('not_authorized')
        ? 'You do not have permission to do that.'
        : 'Could not propose that change.',
    };
  }

  redirect('/dashboard/pending-actions');
}
