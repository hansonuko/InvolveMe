// POST /functions/v1/post-status
//
// Contract: docs/05-API-REALTIME-SPEC.md §1. Debits status_upload_credits_*
// from the caller's topup_credit wallet and inserts a status_updates row,
// per docs/03-ECONOMY-LEDGER.md §7 — no escrow, no earning, unlike
// send-message. No financial logic here (CLAUDE.md rule #1): this function
// only authenticates and forwards to fn_post_status, which does the debit +
// insert atomically and picks the text/media credit amount itself.
// p_user_id is always the authenticated caller's own id, never taken from
// the request body.
//
// No Flutterwave dependency at all — this was the one piece of real
// progress docs/00-SESSION-HANDOFF.md flagged as fully buildable while the
// Flutterwave API-generation question is still open.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface PostStatusRequestBody {
  media_url?: string;
  caption?: string;
}

interface FnPostStatusRow {
  status_id: string;
  credits_charged: number;
  payer_balance_after: number;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// All Edge Functions return { error, message } on failure, per
// docs/05-API-REALTIME-SPEC.md §5.
function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

// Maps the `raise exception` messages fn_post_status can throw to HTTP
// responses, same convention as mapSendMessageError/mapInitiateWithdrawalError.
function mapPostStatusError(pgMessage: string): Response {
  if (pgMessage.startsWith('empty_status')) {
    return errorResponse(400, 'empty_status', 'A status needs a caption or a media_url.');
  }
  if (pgMessage.startsWith('wallet_frozen')) {
    return errorResponse(403, 'wallet_frozen', 'Your wallet is frozen.');
  }
  if (pgMessage.startsWith('wallet_not_found')) {
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }
  if (pgMessage.startsWith('insufficient_credit')) {
    // fn_post_status raises 'insufficient_credit: need % have %', same shape
    // as fn_send_message's error — mapped identically for a consistent
    // client-side contract across both credit-spending endpoints.
    const match = /need (\d+) have (\d+)/.exec(pgMessage);
    return json(402, {
      error: 'insufficient_credit',
      credits_required: match ? Number(match[1]) : null,
      credits_available: match ? Number(match[2]) : null,
    });
  }

  console.error('post-status: unmapped DB error:', pgMessage);
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
    console.error('post-status: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: PostStatusRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (payload.media_url !== undefined && typeof payload.media_url !== 'string') {
    return errorResponse(400, 'invalid_request', 'media_url must be a string.');
  }
  if (payload.caption !== undefined && typeof payload.caption !== 'string') {
    return errorResponse(400, 'invalid_request', 'caption must be a string.');
  }
  if (
    (payload.media_url === undefined || payload.media_url.trim().length === 0) &&
    (payload.caption === undefined || payload.caption.trim().length === 0)
  ) {
    return errorResponse(400, 'empty_status', 'A status needs a caption or a media_url.');
  }

  const db = serviceRoleClient();

  const { data: rawData, error } = await db
    .rpc('fn_post_status', {
      p_user_id: user.id,
      p_media_url: payload.media_url ?? null,
      p_caption: payload.caption ?? null,
    })
    .single();

  if (error) {
    return mapPostStatusError(error.message);
  }

  const data = rawData as FnPostStatusRow;

  return json(200, {
    status_id: data.status_id,
    credits_charged: data.credits_charged,
    payer_balance_after: data.payer_balance_after,
  });
});
