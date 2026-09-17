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
//
// `media_path` (Batch F, session 18) — a `status-media` Storage object
// path the caller already uploaded to via a signed URL from
// create-status-upload-url, never a public URL. `text_style` is the fixed-
// palette template key for a text-only post's background (docs/10-UX-
// REFINEMENT-BACKLOG.md Batch F item 2) — an opaque, non-financial tag, not
// validated against a server-side enum since a bad/unknown value can only
// ever make a status render with a fallback background client-side, never
// anything security- or money-relevant.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadOpenAiModerationConfig } from '../_shared/moderation-config.ts';
import { createOpenAiModerationProvider } from '../../../packages/moderation/openai.ts';

interface PostStatusRequestBody {
  media_path?: string;
  caption?: string;
  text_style?: string;
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

  if (payload.media_path !== undefined && typeof payload.media_path !== 'string') {
    return errorResponse(400, 'invalid_request', 'media_path must be a string.');
  }
  if (payload.caption !== undefined && typeof payload.caption !== 'string') {
    return errorResponse(400, 'invalid_request', 'caption must be a string.');
  }
  if (payload.text_style !== undefined && typeof payload.text_style !== 'string') {
    return errorResponse(400, 'invalid_request', 'text_style must be a string.');
  }
  if (
    (payload.media_path === undefined || payload.media_path.trim().length === 0) &&
    (payload.caption === undefined || payload.caption.trim().length === 0)
  ) {
    return errorResponse(400, 'empty_status', 'A status needs a caption or a media_path.');
  }

  const db = serviceRoleClient();

  // Content moderation (docs/06-SECURITY-FRAUD-LOOPHOLES.md §6,
  // docs/07-COMPLIANCE-LEGAL.md §3) — same posture as send-message's own:
  // checked before fn_post_status so a hard block is never charged or
  // posted. Only the caption is text to moderate; media_url is just a
  // reference (image moderation is out of scope — no media pipeline
  // exists in this app yet, see packages/moderation/provider.ts).
  let flaggedCategories: string[] | null = null;
  if (payload.caption) {
    try {
      const moderation = await createOpenAiModerationProvider(
        loadOpenAiModerationConfig(),
      ).moderateText(payload.caption);

      if (moderation.action === 'blocked') {
        await db.from('moderated_content').insert({
          user_id: user.id,
          content_type: 'status',
          action: 'blocked',
          categories: moderation.categories,
        });
        return errorResponse(
          400,
          'content_blocked',
          'This status violates our content policy and could not be posted.',
        );
      }
      if (moderation.action === 'flagged') {
        flaggedCategories = moderation.categories;
      }
    } catch (e) {
      console.error('post-status: content moderation check failed, allowing post:', e);
    }
  }

  const { data: rawData, error } = await db
    .rpc('fn_post_status', {
      p_user_id: user.id,
      p_media_path: payload.media_path ?? null,
      p_caption: payload.caption ?? null,
      p_text_style: payload.text_style ?? null,
    })
    .single();

  if (error) {
    return mapPostStatusError(error.message);
  }

  const data = rawData as FnPostStatusRow;

  if (flaggedCategories) {
    await db.from('moderated_content').insert({
      user_id: user.id,
      content_type: 'status',
      ref_id: data.status_id,
      action: 'flagged',
      categories: flaggedCategories,
    });
  }

  return json(200, {
    status_id: data.status_id,
    credits_charged: data.credits_charged,
    payer_balance_after: data.payer_balance_after,
  });
});
