'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase-admin';
import { getCurrentAdmin } from '@/lib/auth';
import { loadFlutterwaveConfig } from '@/lib/flutterwave';
import { createFlutterwaveProvider } from '@involveme/payments';

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
  if (message.includes('note_required')) {
    return 'A note explaining the adjustment is required.';
  }
  if (message.includes('invalid_amount')) {
    return 'Amount must be a nonzero whole number.';
  }
  if (message.includes('bank_account_inactive')) {
    return 'That bank account has been deactivated — pick an active one.';
  }
  if (message.includes('bank_account_currency_mismatch')) {
    return "That bank account's currency does not match this withdrawal.";
  }
  if (message.includes('bank_account_not_found')) {
    return 'That bank account no longer exists.';
  }
  if (message.includes('insufficient_platform_revenue')) {
    return 'The platform revenue wallet does not hold enough to cover this withdrawal.';
  }
  if (message.includes('insufficient_platform_earnings_balance')) {
    return 'The platform earnings-cut wallet does not hold enough credits to convert.';
  }
  if (message.includes('admin_user_not_found')) {
    return 'That admin account no longer exists.';
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
  } else if (actionType === 'platform_bank_account_registration') {
    const currency = String(formData.get('currency') ?? '');
    const bankName = String(formData.get('bank_name') ?? '');
    const accountNumberLast4 = String(formData.get('account_number_last4') ?? '');
    const providerAccountId = String(formData.get('provider_account_id') ?? '');
    const accountName = String(formData.get('account_name') ?? '');
    const label = String(formData.get('label') ?? '');
    if (!currency || !bankName || !accountNumberLast4 || !providerAccountId || !accountName) {
      return { error: 'Invalid request.' };
    }

    const { error } = await db().rpc('fn_admin_register_platform_bank_account', {
      p_actor_admin_id: admin.id,
      p_pending_action_id: pendingActionId,
      p_currency: currency,
      p_bank_name: bankName,
      p_account_number_last4: accountNumberLast4,
      p_provider_account_id: providerAccountId,
      p_account_name: accountName,
      p_label: label || null,
    });
    if (error) return { error: friendlyError(error.message) };
  } else if (actionType === 'platform_withdrawal') {
    return applyPlatformWithdrawal(admin.id, pendingActionId, formData);
  } else if (actionType === 'message_pricing_strategy_change') {
    const currency = String(formData.get('currency') ?? '');
    const activeStrategy = String(formData.get('active_strategy') ?? '');
    if (!currency || !activeStrategy) return { error: 'Invalid request.' };

    const { error } = await db().rpc('fn_admin_set_message_pricing_strategy', {
      p_actor_admin_id: admin.id,
      p_pending_action_id: pendingActionId,
      p_currency: currency,
      p_active_strategy: activeStrategy,
    });
    if (error) return { error: friendlyError(error.message) };
  } else if (actionType === 'admin_account_status_change') {
    const targetAdminId = String(formData.get('target_admin_id') ?? '');
    const disable = formData.get('disable') === 'true';
    if (!targetAdminId) return { error: 'Invalid request.' };

    const { error } = await db().rpc('fn_admin_set_admin_account_status', {
      p_actor_admin_id: admin.id,
      p_pending_action_id: pendingActionId,
      p_target_admin_id: targetAdminId,
      p_disable: disable,
    });
    if (error) return { error: friendlyError(error.message) };
  } else {
    return { error: 'Unknown action type.' };
  }

  redirect('/dashboard/pending-actions');
}

// Separated out from applyPendingActionAction proper (rather than inlined
// like every other branch) because this is the one branch that actually
// calls a real payment provider — packages/payments' initiatePayout(),
// against production Flutterwave — and needs its own multi-step
// RPC / provider-call / compensating-RPC shape, mirroring
// supabase/functions/withdraw/index.ts exactly rather than a single RPC
// call like every sibling branch above. Never scripted/automated-tested
// end-to-end against a real provider for exactly that reason — reviewed
// carefully against that proven, live pattern instead.
async function applyPlatformWithdrawal(
  adminId: string,
  pendingActionId: string,
  formData: FormData,
): Promise<PendingActionState> {
  const currency = String(formData.get('currency') ?? '');
  const rawAmount = String(formData.get('amount_minor') ?? '');
  const bankAccountId = String(formData.get('platform_bank_account_id') ?? '');
  if (!currency || !/^\d+$/.test(rawAmount) || !bankAccountId) {
    return { error: 'Invalid request.' };
  }
  const amountMinor = Number(rawAmount);

  // Step 1: the debit. Same shape as fn_initiate_withdrawal — money leaves
  // the platform's own wallet here, before the provider is ever called.
  const { data: withdrawalId, error: initiateError } = await db().rpc(
    'fn_admin_initiate_platform_withdrawal',
    {
      p_actor_admin_id: adminId,
      p_pending_action_id: pendingActionId,
      p_currency: currency,
      p_amount_minor: amountMinor,
      p_platform_bank_account_id: bankAccountId,
    },
  );
  if (initiateError) return { error: friendlyError(initiateError.message) };

  // Step 2: resolve the real payout destination server-side — never trust
  // a client-passed provider_account_id for the actual money movement,
  // even though fn_admin_initiate_platform_withdrawal already validated
  // the bank account's currency/active status above.
  const { data: bankAccount, error: bankAccountError } = await db()
    .from('platform_bank_accounts')
    .select('provider_account_id')
    .eq('id', bankAccountId)
    .single();

  if (bankAccountError || !bankAccount) {
    // The debit already happened and is now stranded exactly like
    // withdraw/index.ts's own documented "debit succeeded, nothing else
    // did" case — fail it the same way rather than leaving it processing
    // forever with no provider call ever attempted.
    await db().rpc('fn_admin_fail_platform_withdrawal', {
      p_platform_withdrawal_id: withdrawalId,
    });
    return { error: 'Could not resolve the payout destination. The debit has been reversed.' };
  }

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());

  try {
    await provider.initiatePayout({
      amountKobo: amountMinor,
      recipientId: bankAccount.provider_account_id,
      reference: withdrawalId,
    });
  } catch (e) {
    console.error('applyPlatformWithdrawal: provider.initiatePayout failed:', e);
    const { error: failError } = await db().rpc('fn_admin_fail_platform_withdrawal', {
      p_platform_withdrawal_id: withdrawalId,
    });
    if (failError) {
      // Same escalate-loudly posture as withdraw/index.ts: no automatic
      // recovery path exists for a stranded debit, so this is worth a
      // real log line, not a silently swallowed second failure.
      console.error(
        'applyPlatformWithdrawal: fn_admin_fail_platform_withdrawal ALSO failed after a provider error — debit may be stranded:',
        failError.message,
      );
    }
    return {
      error:
        'The withdrawal could not be processed by the payment provider right now. The debit has been reversed.',
    };
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

export async function proposePlatformWithdrawalAction(
  _prev: PendingActionState,
  formData: FormData,
): Promise<PendingActionState> {
  const admin = await requireAdmin();
  const currency = String(formData.get('currency') ?? '');
  const rawAmount = String(formData.get('amount_minor') ?? '').trim();
  const bankAccountId = String(formData.get('platform_bank_account_id') ?? '');

  if (!currency || !bankAccountId || !/^\d+$/.test(rawAmount)) {
    return { error: 'Enter a whole positive number of kobo and pick a destination account.' };
  }
  const amountMinor = Number(rawAmount);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    return { error: 'Amount must be a positive whole number.' };
  }

  const { error } = await db().rpc('fn_admin_propose_pending_action', {
    p_actor_admin_id: admin.id,
    p_action_type: 'platform_withdrawal',
    p_payload: { currency, amount_minor: amountMinor, platform_bank_account_id: bankAccountId },
  });
  if (error) return { error: friendlyError(error.message) };

  redirect('/dashboard/pending-actions');
}

const MESSAGE_PRICING_STRATEGIES = ['tiered_word_block', 'flat_per_message', 'linear_per_word'];

export async function proposeMessagePricingStrategyChangeAction(
  _prev: PendingActionState,
  formData: FormData,
): Promise<PendingActionState> {
  const admin = await requireAdmin();
  const currency = String(formData.get('currency') ?? '');
  const activeStrategy = String(formData.get('active_strategy') ?? '');

  if (!currency || !MESSAGE_PRICING_STRATEGIES.includes(activeStrategy)) {
    return { error: 'Pick a valid strategy.' };
  }

  const { error } = await db().rpc('fn_admin_propose_pending_action', {
    p_actor_admin_id: admin.id,
    p_action_type: 'message_pricing_strategy_change',
    p_payload: { currency, active_strategy: activeStrategy },
  });
  if (error) return { error: friendlyError(error.message) };

  redirect('/dashboard/pending-actions');
}
