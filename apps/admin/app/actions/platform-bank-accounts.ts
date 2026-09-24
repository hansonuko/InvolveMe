'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/supabase-admin';
import { getCurrentAdmin } from '@/lib/auth';
import { loadFlutterwaveConfig } from '@/lib/flutterwave';
import { createFlutterwaveProvider, PaymentProviderError } from '@involveme/payments';

async function requireAdmin() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');
  return admin;
}

export type ResolveBankAccountState =
  { accountName: string; bankCode: string; accountNumber: string } | { error: string } | null;

// Read-only lookup, never a write — this is the "look up account" step
// before "propose registration" (see the propose action below). A real
// Flutterwave call (resolveBankAccountName), but non-mutating: it never
// creates or moves anything at the provider, matching the boundary this
// whole phase draws between "a live call that could move money" and
// everything else.
export async function resolveBankAccountNameAction(
  _prev: ResolveBankAccountState,
  formData: FormData,
): Promise<ResolveBankAccountState> {
  await requireAdmin();
  const bankCode = String(formData.get('bank_code') ?? '').trim();
  const accountNumber = String(formData.get('account_number') ?? '').trim();

  if (!bankCode || !accountNumber) {
    return { error: 'Pick a bank and enter an account number.' };
  }

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());
  try {
    const result = await provider.resolveBankAccountName({ bankCode, accountNumber });
    return { accountName: result.accountName, bankCode, accountNumber };
  } catch (e) {
    if (e instanceof PaymentProviderError && e.status >= 400 && e.status < 500) {
      return { error: 'That account could not be verified — check the details and try again.' };
    }
    console.error('resolveBankAccountNameAction:', e);
    return { error: 'Could not reach the payment provider right now.' };
  }
}

export type ProposeBankAccountState = { error: string } | null;

// The one mutating Flutterwave call in this flow (createTransferRecipient)
// happens here, at propose time — deliberately, not deferred to apply
// time, because fn_admin_register_platform_bank_account's payload-match
// check (piece 1) already requires the real provider_account_id to be
// part of the proposed payload a second admin reviews and approves. A
// rejected/expired proposal still leaves a harmless, idempotent
// (idempotencyKey-keyed at the packages/payments layer) recipient object
// registered at Flutterwave — it never moves money on its own.
export async function proposePlatformBankAccountRegistrationAction(
  _prev: ProposeBankAccountState,
  formData: FormData,
): Promise<ProposeBankAccountState> {
  const admin = await requireAdmin();
  const currency = String(formData.get('currency') ?? '').trim();
  const bankCode = String(formData.get('bank_code') ?? '').trim();
  const bankName = String(formData.get('bank_name') ?? '').trim();
  const accountNumber = String(formData.get('account_number') ?? '').trim();
  const accountName = String(formData.get('account_name') ?? '').trim();
  const label = String(formData.get('label') ?? '').trim();

  if (!currency || !bankCode || !bankName || !accountNumber || !accountName) {
    return { error: 'Look up the account first, then propose.' };
  }

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());
  let providerAccountId: string;
  try {
    const recipient = await provider.createTransferRecipient({ bankCode, accountNumber });
    providerAccountId = recipient.recipientId;
  } catch (e) {
    if (e instanceof PaymentProviderError && e.status >= 400 && e.status < 500) {
      return { error: 'That account could not be registered with the payment provider.' };
    }
    console.error('proposePlatformBankAccountRegistrationAction:', e);
    return { error: 'Could not reach the payment provider right now.' };
  }

  const accountNumberLast4 = accountNumber.slice(-4);

  const { error } = await db().rpc('fn_admin_propose_pending_action', {
    p_actor_admin_id: admin.id,
    p_action_type: 'platform_bank_account_registration',
    p_payload: {
      currency,
      bank_name: bankName,
      account_number_last4: accountNumberLast4,
      provider_account_id: providerAccountId,
      account_name: accountName,
      label: label || null,
    },
  });
  if (error) {
    return {
      error: error.message.includes('not_authorized')
        ? 'You do not have permission to do that.'
        : 'Could not propose that registration.',
    };
  }

  redirect('/dashboard/pending-actions');
}

export type DeactivateBankAccountState = { error: string } | null;

// Single-admin by design (docs/14 §5 / piece 1's migration header) —
// deactivating only removes a withdrawal option, the opposite risk
// direction from registering a new one.
export async function deactivatePlatformBankAccountAction(
  _prev: DeactivateBankAccountState,
  formData: FormData,
): Promise<DeactivateBankAccountState> {
  const admin = await requireAdmin();
  const bankAccountId = String(formData.get('bank_account_id') ?? '');
  if (!bankAccountId) return { error: 'Invalid request.' };

  const { error } = await db().rpc('fn_admin_deactivate_platform_bank_account', {
    p_actor_admin_id: admin.id,
    p_bank_account_id: bankAccountId,
  });
  if (error) {
    return {
      error: error.message.includes('not_authorized')
        ? 'You do not have permission to do that.'
        : error.message.includes('bank_account_not_found_or_already_inactive')
          ? 'That account is already inactive.'
          : 'Could not deactivate that account.',
    };
  }

  redirect('/dashboard/treasury');
}

export type ConvertEarningsState = { error: string } | null;

// Single-admin by design (piece 1) — never moves value out of the
// platform, and the exchange rate (credit_unit_kobo) isn't admin-chosen.
export async function convertPlatformEarningsToCashAction(
  _prev: ConvertEarningsState,
  formData: FormData,
): Promise<ConvertEarningsState> {
  const admin = await requireAdmin();
  const currency = String(formData.get('currency') ?? '');
  const rawCredits = String(formData.get('credits') ?? '').trim();

  if (!currency || !/^\d+$/.test(rawCredits)) {
    return { error: 'Enter a positive whole number of credits.' };
  }
  const credits = Number(rawCredits);
  if (!Number.isSafeInteger(credits) || credits <= 0) {
    return { error: 'Credits must be a positive whole number.' };
  }

  const { error } = await db().rpc('fn_admin_convert_platform_earnings_to_cash', {
    p_actor_admin_id: admin.id,
    p_currency: currency,
    p_credits: credits,
  });
  if (error) {
    return {
      error: error.message.includes('not_authorized')
        ? 'You do not have permission to do that.'
        : error.message.includes('insufficient_platform_earnings_balance')
          ? 'The platform earnings-cut wallet does not hold enough credits to convert.'
          : 'Could not convert that amount.',
    };
  }

  redirect('/dashboard/treasury');
}
