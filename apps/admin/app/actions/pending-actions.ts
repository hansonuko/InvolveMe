'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase-admin';
import { getCurrentAdmin } from '@/lib/auth';

export type PendingActionState = { error: string } | null;

async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');
  return admin;
}

// Maps the DB's own exception strings (supabase/migrations/20260923090000_
// admin_dual_approval_pending_actions.sql /
// 20260923110000_admin_pricing_dual_approval_and_manual_adjustment.sql)
// to admin-facing copy — the DB is the real authority on every one of
// these, this is presentation only.
function friendlyError(message: string): string {
  if (message.includes('cannot_approve_own_action')) {
    return 'You proposed this change — a different admin has to approve it.';
  }
  if (message.includes('not_authorized')) {
    return 'You do not have permission to do that.';
  }
  if (message.includes('pending_action_expired')) {
    return 'This proposal expired (72h) and can no longer be approved or rejected.';
  }
  if (message.includes('pending_action_not_pending')) {
    return 'This proposal has already been decided.';
  }
  if (message.includes('pending_action_not_found')) {
    return 'That proposal no longer exists.';
  }
  if (message.includes('pending_action_payload_mismatch')) {
    return 'The approved change no longer matches what is being applied — ask a super_admin to check.';
  }
  if (message.includes('pending_action_not_approved_or_already_executed')) {
    return 'This proposal is not approved, or has already been applied.';
  }
  if (message.includes('wallet_frozen')) {
    return 'That wallet is frozen — unfreeze it first.';
  }
  if (message.includes('insufficient_balance_for_adjustment')) {
    return 'That debit would take the wallet balance negative.';
  }
  if (message.includes('bps_value_out_of_range')) {
    return 'Basis-point values cannot exceed 10000 (100%).';
  }
  if (message.includes('negative_value_not_allowed')) {
    return 'Value cannot be negative.';
  }
  if (message.includes('pricing_config_key_not_found')) {
    return 'That config key no longer exists.';
  }
  return 'Could not complete that action.';
}

export async function approvePendingActionAction(
  _prev: PendingActionState,
  formData: FormData,
): Promise<PendingActionState> {
  const admin = await requireAdmin();
  const pendingActionId = String(formData.get('pending_action_id') ?? '');
  if (!pendingActionId) return { error: 'Invalid request.' };

  const { error } = await db().rpc('fn_admin_approve_pending_action', {
    p_actor_admin_id: admin.id,
    p_pending_action_id: pendingActionId,
  });
  if (error) return { error: friendlyError(error.message) };

  redirect('/dashboard/pending-actions');
}

export async function rejectPendingActionAction(
  _prev: PendingActionState,
  formData: FormData,
): Promise<PendingActionState> {
  const admin = await requireAdmin();
  const pendingActionId = String(formData.get('pending_action_id') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  if (!pendingActionId) return { error: 'Invalid request.' };

  const { error } = await db().rpc('fn_admin_reject_pending_action', {
    p_actor_admin_id: admin.id,
    p_pending_action_id: pendingActionId,
    p_reason: reason || null,
  });
  if (error) return { error: friendlyError(error.message) };

  redirect('/dashboard/pending-actions');
}

// Redeems an approved proposal by re-submitting exactly the payload the
// queue page read off admin_pending_actions.payload when it rendered
// (passed through as hidden fields) — never new user input at apply-time,
// so what gets applied can never drift from what was actually approved.
// fn_admin_update_pricing_config / fn_admin_post_manual_adjustment both
// re-verify this server-side anyway (pending_action_payload_mismatch),
// this is just what keeps the form itself from ever having a reason to
// disagree with what was approved.
export async function applyPendingActionAction(
  _prev: PendingActionState,
  formData: FormData,
): Promise<PendingActionState> {
  const admin = await requireAdmin();
  const pendingActionId = String(formData.get('pending_action_id') ?? '');
  const actionType = String(formData.get('action_type') ?? '');
  if (!pendingActionId) return { error: 'Invalid request.' };

  if (actionType === 'pricing_config_update') {
    const key = String(formData.get('key') ?? '');
    const currency = String(formData.get('currency') ?? '');
    const rawValue = String(formData.get('new_value') ?? '');
    if (!key || !currency || !/^-?\d+$/.test(rawValue)) return { error: 'Invalid request.' };

    const { error } = await db().rpc('fn_admin_update_pricing_config', {
      p_actor_admin_id: admin.id,
      p_key: key,
      p_currency: currency,
      p_new_value: Number(rawValue),
      p_pending_action_id: pendingActionId,
    });
    if (error) return { error: friendlyError(error.message) };
  } else if (actionType === 'manual_ledger_adjustment') {
    const walletId = String(formData.get('wallet_id') ?? '');
    const rawAmount = String(formData.get('amount') ?? '');
    const note = String(formData.get('note') ?? '');
    if (!walletId || !/^-?\d+$/.test(rawAmount)) return { error: 'Invalid request.' };

    const { error } = await db().rpc('fn_admin_post_manual_adjustment', {
      p_actor_admin_id: admin.id,
      p_pending_action_id: pendingActionId,
      p_wallet_id: walletId,
      p_amount: Number(rawAmount),
      p_note: note,
    });
    if (error) return { error: friendlyError(error.message) };
  } else {
    return { error: 'Unknown action type.' };
  }

  redirect('/dashboard/pending-actions');
}

export async function proposeManualAdjustmentAction(
  _prev: PendingActionState,
  formData: FormData,
): Promise<PendingActionState> {
  const admin = await requireAdmin();
  const walletId = String(formData.get('wallet_id') ?? '');
  const rawAmount = String(formData.get('amount') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim();

  if (!walletId || !/^-?\d+$/.test(rawAmount)) {
    return { error: 'Enter a whole number amount (positive to credit, negative to debit).' };
  }
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount) || amount === 0) {
    return { error: 'Amount must be a nonzero whole number.' };
  }
  if (!note) {
    return { error: 'A note explaining the adjustment is required.' };
  }

  const { error } = await db().rpc('fn_admin_propose_pending_action', {
    p_actor_admin_id: admin.id,
    p_action_type: 'manual_ledger_adjustment',
    p_payload: { wallet_id: walletId, amount, note },
  });
  if (error) return { error: friendlyError(error.message) };

  redirect('/dashboard/pending-actions');
}
