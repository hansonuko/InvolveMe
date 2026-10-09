// POST /functions/v1/link-bank-account
//
// New this session — the flow that actually populates
// `bank_accounts.provider_account_id` for a real user (see
// packages/payments/provider.ts's `PayoutRequest` comment: nothing had
// ever called this before; every `bank_accounts` row `withdraw` could use
// was a manually-inserted test fixture).
//
// No financial logic on the client (CLAUDE.md rule #1): the client sends a
// bank code + account number it got from `list-banks`-shaped reference
// data, and this function does everything else server-side — resolves the
// account's registered name via Flutterwave, name-matches it against the
// user's KYC-verified identity (never against unverified user input),
// and only then creates a real Flutterwave transfer recipient and writes
// bank_accounts. Per CLAUDE.md rule #7 ("nothing withdraws to an
// unverified bank account... never skip verification"), a name mismatch
// is a hard rejection, not a row inserted with name_match_verified: false
// for someone to fix later — there's no admin review flow for that state
// yet, so the safer failure mode is "nothing was linked" over "something
// ambiguous was linked."
//
// Requires KYC tier >= 1 (submit-kyc) — this is the second half of what
// docs/03-ECONOMY-LEDGER.md §6 requires before a withdrawal can complete.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadFlutterwaveConfig } from '../_shared/flutterwave-config.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';
import {
  createFlutterwaveProvider,
  PaymentProviderError,
} from '../../../packages/payments/flutterwave.ts';

// A 4xx from Flutterwave means the specific input was rejected (e.g. a
// nonexistent account number) — the user needs to fix what they typed, not
// retry the same request. Only a real outage (network failure, 5xx) maps
// to 503. Distinguishing this matters for testability too: an invalid
// account number is a real, deterministic, zero-side-effect way to
// exercise this function's error path against the live API, the same way
// withdraw's test exercises a real RECIPIENT_NOT_FOUND with a fake id.
function mapProviderError(e: unknown, fallbackMessage: string): Response {
  if (e instanceof PaymentProviderError && e.status >= 400 && e.status < 500) {
    return errorResponse(
      400,
      'invalid_account',
      'That account could not be verified — check the details and try again.',
    );
  }
  console.error('link-bank-account:', e);
  return errorResponse(503, 'payment_provider_unavailable', fallbackMessage);
}

const ACCOUNT_NUMBER_MSG = 'account_number must be exactly 10 digits.';
const LinkBankAccountRequestSchema = z.object({
  bank_code: requiredString('bank_code'),
  bank_name: z.string().optional(),
  account_number: z
    .string({ required_error: ACCOUNT_NUMBER_MSG, invalid_type_error: ACCOUNT_NUMBER_MSG })
    .regex(/^\d{10}$/, ACCOUNT_NUMBER_MSG),
});

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

// Order-independent, punctuation-insensitive: requires every token of the
// KYC-verified first+last name to appear somewhere in the bank's
// registered account name. Nigerian bank names and BVN/NIN records don't
// agree on token order (e.g. "SURNAME FIRSTNAME" vs "FIRSTNAME SURNAME"),
// so an exact-string or fixed-order comparison would reject real matches
// — documented as a deliberate v1 heuristic, not a formal name-matching
// library.
function namesRoughlyMatch(
  kycFirstName: string,
  kycLastName: string,
  bankAccountName: string,
): boolean {
  const normalize = (s: string) =>
    s
      .toUpperCase()
      .replace(/[^A-Z\s]/g, '')
      .split(/\s+/)
      .filter(Boolean);

  const bankTokens = new Set(normalize(bankAccountName));
  const kycTokens = normalize(`${kycFirstName} ${kycLastName}`);
  return kycTokens.length > 0 && kycTokens.every((t) => bankTokens.has(t));
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  // blockLinkedDevices: a linked/companion web session is chat-and-status
  // only (docs/12-LINKED-DEVICES-WEB-SCOPING.md §4) — never wallet
  // actions, no exceptions.
  let user;
  try {
    user = await requireAuthenticatedUser(req, { blockLinkedDevices: true });
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('link-bank-account: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(LinkBankAccountRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();

  const { data: userRow } = await db.from('users').select('kyc_tier').eq('id', user.id).single();
  if (!userRow || (userRow.kyc_tier ?? 0) < 1) {
    return errorResponse(
      403,
      'kyc_required',
      'Verify your identity before linking a bank account.',
    );
  }

  const { data: kycRecord, error: kycError } = await db
    .from('kyc_records')
    .select('verified_first_name, verified_last_name')
    .eq('user_id', user.id)
    .eq('status', 'verified')
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (kycError || !kycRecord?.verified_first_name || !kycRecord?.verified_last_name) {
    // Shouldn't happen if kyc_tier is already >= 1 (submit-kyc only bumps
    // it alongside a verified record with these fields set) — but fails
    // loudly rather than silently name-matching against nothing.
    console.error(
      'link-bank-account: kyc_tier >= 1 but no usable verified kyc_records row:',
      kycError?.message,
    );
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const provider = createFlutterwaveProvider(loadFlutterwaveConfig());

  let resolved;
  try {
    resolved = await provider.resolveBankAccountName({
      bankCode: payload.bank_code,
      accountNumber: payload.account_number,
    });
  } catch (e) {
    return mapProviderError(
      e,
      'Could not verify that account right now — please try again shortly.',
    );
  }

  if (
    !namesRoughlyMatch(
      kycRecord.verified_first_name,
      kycRecord.verified_last_name,
      resolved.accountName,
    )
  ) {
    await db.from('fraud_signals').insert({
      user_id: user.id,
      signal_type: 'bank_account_name_mismatch',
      severity: 'medium',
      metadata: {
        bank_code: payload.bank_code,
        account_number_last4: payload.account_number.slice(-4),
      },
    });
    return errorResponse(
      422,
      'name_mismatch',
      'This account name does not match your verified identity.',
    );
  }

  let recipient;
  try {
    recipient = await provider.createTransferRecipient({
      bankCode: payload.bank_code,
      accountNumber: payload.account_number,
    });
  } catch (e) {
    return mapProviderError(e, 'Could not link this account right now — please try again shortly.');
  }

  const { data: bankAccount, error: insertError } = await db
    .from('bank_accounts')
    .insert({
      user_id: user.id,
      provider_account_id: recipient.recipientId,
      account_number_last4: payload.account_number.slice(-4),
      bank_name: payload.bank_name ?? null,
      account_name: resolved.accountName,
      name_match_verified: true,
    })
    .select('id, bank_name, account_name, account_number_last4')
    .single();

  if (insertError || !bankAccount) {
    console.error('link-bank-account: could not save the linked account:', insertError?.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, {
    bank_account_id: bankAccount.id,
    bank_name: bankAccount.bank_name,
    account_name: bankAccount.account_name,
    account_number_last4: bankAccount.account_number_last4,
  });
});
