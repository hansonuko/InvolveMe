// POST /functions/v1/transfer-credit
//
// Peer-to-peer chat-credit transfer, convertible to cash on the recipient's
// side — see the header comment on
// supabase/migrations/20260913091500_credit_transfer_between_users.sql for
// the full compliance context (docs/07-COMPLIANCE-LEGAL.md §1 names this
// exact pattern as something that needs a legal check before it ships;
// this was built anyway on an explicit, informed product-owner decision,
// not an oversight — it stays flagged in docs/00-SESSION-HANDOFF.md's
// pre-launch checklist).
//
// No financial logic here (CLAUDE.md rule #1): fn_transfer_credit does the
// whole debit/credit/platform-cut/cash-conversion inside one transaction
// with row-level locking; this function only authenticates, resolves
// `recipient_phone` to a user id (same normalization find-user-by-phone
// uses — Supabase Auth strips the leading "+" before storage), and maps
// the DB function's exceptions to HTTP responses.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { runInBackground, sendPushToUser } from '../_shared/push.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';

const CREDITS_MSG = 'credits must be a positive integer.';
const TransferCreditRequestSchema = z.object({
  recipient_phone: requiredString('recipient_phone'),
  credits: z
    .number({ required_error: CREDITS_MSG, invalid_type_error: CREDITS_MSG })
    .int(CREDITS_MSG)
    .positive(CREDITS_MSG),
  note: z.string({ invalid_type_error: 'note must be a string.' }).optional(),
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

// Maps fn_transfer_credit's `raise exception` messages to HTTP status, same
// prefix-matching convention as withdraw's mapInitiateWithdrawalError.
function mapTransferCreditError(pgMessage: string): Response {
  if (pgMessage.startsWith('invalid_amount')) {
    return errorResponse(400, 'invalid_amount', 'credits must be a positive integer.');
  }
  if (pgMessage.startsWith('cannot_transfer_to_self')) {
    return errorResponse(400, 'invalid_request', "You can't transfer credit to yourself.");
  }
  if (pgMessage.startsWith('sender_not_found')) {
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }
  if (pgMessage.startsWith('sender_suspended')) {
    return errorResponse(403, 'sender_suspended', 'Your account is suspended.');
  }
  if (pgMessage.startsWith('recipient_not_found')) {
    return errorResponse(404, 'user_not_found', 'No InvolveMe user has that phone number.');
  }
  if (pgMessage.startsWith('recipient_suspended')) {
    return errorResponse(403, 'recipient_suspended', "That account can't receive credit.");
  }
  if (pgMessage.startsWith('recipient_kyc_required')) {
    // docs/06-SECURITY-FRAUD-LOOPHOLES.md §2 — a Tier-0 recipient could
    // otherwise accumulate withdrawable cash it could never earn or
    // withdraw through any other path in this app.
    return errorResponse(
      403,
      'recipient_kyc_required',
      "That user hasn't verified their identity yet, so they can't receive credit transfers.",
    );
  }
  if (pgMessage.startsWith('amount_over_transfer_cap')) {
    return errorResponse(
      400,
      'amount_over_transfer_cap',
      'That amount is over the per-transfer limit.',
    );
  }
  if (pgMessage.startsWith('wallet_frozen')) {
    return errorResponse(403, 'wallet_frozen', 'A wallet involved in this transfer is frozen.');
  }
  if (pgMessage.startsWith('insufficient_credit')) {
    return errorResponse(402, 'insufficient_credit', "You don't have enough credit.");
  }

  console.error('transfer-credit: unmapped DB error:', pgMessage);
  return errorResponse(500, 'internal_error', 'Something went wrong.');
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
    console.error('transfer-credit: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(TransferCreditRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  // See find-user-by-phone's header comment for why this strip is required.
  const normalizedPhone = payload.recipient_phone.replace(/^\+/, '');

  const db = serviceRoleClient();

  const { data: recipient, error: lookupError } = await db
    .from('users')
    .select('id')
    .eq('phone', normalizedPhone)
    .maybeSingle();

  if (lookupError) {
    console.error('transfer-credit: recipient lookup failed:', lookupError.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }
  if (!recipient) {
    return errorResponse(404, 'user_not_found', 'No InvolveMe user has that phone number.');
  }

  const { data: transferId, error: transferError } = await db.rpc('fn_transfer_credit', {
    p_sender_id: user.id,
    p_recipient_id: recipient.id,
    p_credits: payload.credits,
    p_note: payload.note ?? null,
  });

  if (transferError) {
    return mapTransferCreditError(transferError.message);
  }

  const { data: transfer, error: readBackError } = await db
    .from('credit_transfers')
    .select('credits_sent, platform_cut_credits, credits_received')
    .eq('id', transferId)
    .single();

  if (readBackError || !transfer) {
    console.error(
      'transfer-credit: could not read back the transfer it just created:',
      readBackError?.message,
    );
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  runInBackground(async () => {
    const { data: sender } = await db
      .from('users')
      .select('display_name')
      .eq('id', user.id)
      .single();
    await sendPushToUser(
      db,
      recipient.id,
      sender?.display_name ?? 'Someone',
      `Sent you ${transfer.credits_received} credits`,
      { type: 'credit_transfer_received', transfer_id: transferId },
    );
  });

  return json(200, {
    transfer_id: transferId,
    credits_sent: transfer.credits_sent,
    platform_cut_credits: transfer.platform_cut_credits,
    credits_received: transfer.credits_received,
  });
});
