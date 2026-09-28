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
// initiatePayout is a real call against Flutterwave's /transfers v4 API
// (packages/payments/flutterwave.ts) — the header comment here used to call
// it "currently a stub," which was stale and, per docs/00-SESSION-HANDOFF.md,
// no real payout has ever actually succeeded through it yet, only failed. On
// a provider failure, the caught error's message (which carries Flutterwave's
// own raw rejection reason — see PaymentProviderError) is now stored on
// `withdrawals.failure_reason` via fn_fail_withdrawal, not just
// console.error'd, specifically so the next failure is diagnosable without
// needing Edge Function log access this project has repeatedly not had.

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
    const providerErrorMessage = e instanceof Error ? e.message : String(e);
    console.error('withdraw: provider.initiatePayout failed:', providerErrorMessage);

    const { error: failError } = await db.rpc('fn_fail_withdrawal', {
      p_withdrawal_id: withdrawal.withdrawal_id,
      // Stored on the withdrawal row (not just logged) so the actual
      // provider rejection reason is queryable later — this project has
      // repeatedly not had a working path to read Edge Function logs back.
      // Truncated: PaymentProviderError's own message already caps the
      // provider's raw response body at 500 chars; this is a further,
      // generous ceiling against anything else that might throw here.
      p_failure_reason: providerErrorMessage.slice(0, 1000),
    });

    if (failError) {
      // The compensating reversal itself failed — the debit may genuinely
      // be stranded (no automatic recovery path exists yet, same
      // documented gap as Phase 1 item 5's reconciliation job). Telling
      // the user "your balance has not been debited" here would be a
      // false claim this code cannot actually guarantee, so this path
      // gets its own honest message instead of repeating that one.
      // fn_fail_withdrawal already failed, so this marks the row directly
      // rather than routing back through the RPC that just failed.
      console.error(
        'withdraw: fn_fail_withdrawal ALSO failed after a provider error — debit may be stranded:',
        failError.message,
      );

      const { error: holdError } = await db
        .from('withdrawals')
        .update({
          status: 'held_for_review',
          failure_reason: `provider_error=${providerErrorMessage.slice(0, 400)}; reversal_error=${failError.message.slice(0, 400)}`,
        })
        .eq('id', withdrawal.withdrawal_id);
      if (holdError) {
        console.error(
          'withdraw: could not even mark the withdrawal held_for_review:',
          holdError.message,
        );
      }

      return errorResponse(
        500,
        'withdrawal_needs_review',
        "Something went wrong processing your withdrawal and it needs manual review — we can't yet confirm whether your balance was debited. Contact support with this reference: " +
          withdrawal.withdrawal_id,
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
