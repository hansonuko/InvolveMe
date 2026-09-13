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

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface TransferCreditRequestBody {
  recipient_phone?: string;
  credits?: number;
  note?: string;
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

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('transfer-credit: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: TransferCreditRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.recipient_phone !== 'string' || payload.recipient_phone.trim().length === 0) {
    return errorResponse(400, 'invalid_request', 'recipient_phone is required.');
  }
  if (
    typeof payload.credits !== 'number' ||
    !Number.isInteger(payload.credits) ||
    payload.credits <= 0
  ) {
    return errorResponse(400, 'invalid_request', 'credits must be a positive integer.');
  }
  if (payload.note !== undefined && typeof payload.note !== 'string') {
    return errorResponse(400, 'invalid_request', 'note must be a string.');
  }

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

  return json(200, {
    transfer_id: transferId,
    credits_sent: transfer.credits_sent,
    platform_cut_credits: transfer.platform_cut_credits,
    credits_received: transfer.credits_received,
  });
});
