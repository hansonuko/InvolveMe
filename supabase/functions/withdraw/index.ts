// POST /functions/v1/withdraw
//
// Contract: docs/05-API-REALTIME-SPEC.md §1. Requires KYC tier ≥ 1 and a
// verified, provider-linked bank account. No financial logic here — this
// function authenticates, resolves the bank account's provider recipient
// reference, calls fn_initiate_withdrawal (which does the debit), then
// calls PaymentProvider.initiatePayout(); on provider failure it calls
// fn_fail_withdrawal so the debit doesn't strand (per
// docs/00-SESSION-HANDOFF.md's Phase 1 notes on why fn_fail_withdrawal
// exists — make sure this path is actually exercised, not just written).
//
// initiatePayout is currently a stub (see packages/payments/flutterwave.ts)
// pending a Flutterwave API-generation decision — every real call today
// exercises the provider-failure/fn_fail_withdrawal path for real, which is
// the safety-critical half of this function regardless of which API
// eventually backs it.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import { parseBody, requiredUuid } from '../_shared/validate.ts';
import { createFlutterwaveProvider } from '../../../packages/payments/flutterwave.ts';

const AMOUNT_KOBO_MSG = 'amount_kobo must be a positive integer.';
const WithdrawRequestSchema = z.object({
  bank_account_id: requiredUuid('bank_account_id'),
  amount_kobo: z
    .number({ invalid_type_error: AMOUNT_KOBO_MSG })
    .int(AMOUNT_KOBO_MSG)
    .positive(AMOUNT_KOBO_MSG)
    .optional(),
});

interface FnInitiateWithdrawalRow {
  withdrawal_id: string;
  amount_kobo: number;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

// Maps fn_initiate_withdrawal's `raise exception` messages to HTTP status,
// per the 403-bucket docs/05-API-REALTIME-SPEC.md documents plus
// invalid_amount (raised by the function, not yet in that doc's list).
function mapInitiateWithdrawalError(pgMessage: string): Response {
  if (pgMessage.startsWith('kyc_required')) {
    return errorResponse(403, 'kyc_required', 'KYC verification is required to withdraw.');
  }
  if (pgMessage.startsWith('bank_account_unverified')) {
    return errorResponse(403, 'bank_account_unverified', "This bank account isn't verified.");
  }
  if (pgMessage.startsWith('below_minimum')) {
    return errorResponse(403, 'below_minimum', 'Amount is below the minimum withdrawal.');
  }
  if (pgMessage.startsWith('daily_limit_exceeded')) {
    return errorResponse(403, 'daily_limit_exceeded', 'Daily withdrawal limit exceeded.');
  }
  if (pgMessage.startsWith('invalid_amount')) {
    return errorResponse(400, 'invalid_amount', 'Requested amount exceeds available balance.');
  }
  if (pgMessage.startsWith('wallet_frozen')) {
    return errorResponse(403, 'wallet_frozen', 'Your wallet is frozen.');
  }

  console.error('withdraw: unmapped DB error:', pgMessage);
  return errorResponse(500, 'internal_error', 'Something went wrong.');
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
    console.error('withdraw: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(WithdrawRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;
  const bankAccountId = payload.bank_account_id;

  const db = serviceRoleClient();

  // Resolved up front, before ever debiting: fn_initiate_withdrawal
  // already re-validates ownership + name_match_verified itself (it won't
  // debit on a bad bank_account_id regardless), but it has no way to know
  // whether a payout is even *possible* without a provider_account_id —
  // checking that here avoids a debit-then-immediately-reverse round trip
  // for the common case of an account that's KYC-verified but never
  // linked to a payout provider.
  const { data: bankAccount, error: bankAccountError } = await db
    .from('bank_accounts')
    .select('provider_account_id, name_match_verified')
    .eq('id', bankAccountId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (bankAccountError) {
    console.error('withdraw: bank_accounts lookup failed:', bankAccountError.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  if (!bankAccount || !bankAccount.name_match_verified || !bankAccount.provider_account_id) {
    return errorResponse(403, 'bank_account_unverified', "This bank account isn't verified.");
  }

  const { data: withdrawalRow, error: initiateError } = await db
    .rpc('fn_initiate_withdrawal', {
      p_user_id: user.id,
      p_bank_account_id: bankAccountId,
      p_amount_kobo: payload.amount_kobo ?? null,
      p_bypass_minimum: false,
    })
    .single();

  if (initiateError) {
    return mapInitiateWithdrawalError(initiateError.message);
  }

  const withdrawal = withdrawalRow as FnInitiateWithdrawalRow;

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());

  try {
    await provider.initiatePayout({
      amountKobo: withdrawal.amount_kobo,
      recipientId: bankAccount.provider_account_id,
      reference: withdrawal.withdrawal_id,
    });
  } catch (e) {
    console.error('withdraw: provider.initiatePayout failed:', e);

    const { error: failError } = await db.rpc('fn_fail_withdrawal', {
      p_withdrawal_id: withdrawal.withdrawal_id,
    });
    if (failError) {
      // The debit is now stranded — this is the one case worth escalating
      // loudly rather than just logging, since no automatic recovery path
      // exists yet (no on-call paging, same documented gap as Phase 1
      // item 5's reconciliation job).
      console.error(
        'withdraw: fn_fail_withdrawal ALSO failed after a provider error — debit may be stranded:',
        failError.message,
      );
    }

    return errorResponse(
      503,
      'payment_provider_unavailable',
      'Withdrawal could not be processed right now. Your balance has not been debited.',
    );
  }

  return json(200, {
    withdrawal_id: withdrawal.withdrawal_id,
    amount_kobo: withdrawal.amount_kobo,
    status: 'processing',
  });
});
