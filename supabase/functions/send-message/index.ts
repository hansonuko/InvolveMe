// POST /functions/v1/send-message
//
// Contract: docs/05-API-REALTIME-SPEC.md §1. Accepts { thread_id?,
// recipient_id?, body }, not just { thread_id, body } as originally
// documented — there was no "start a new conversation" call, so a missing
// thread_id starts one via fn_start_thread(caller, recipient) before
// sending. Doc updated alongside this function, per docs/09's "new Edge
// Function" convention and this project's "don't let the doc drift from
// what's built" discipline.
//
// No financial logic lives here (CLAUDE.md rule #1) — this function only
// authenticates the caller, resolves/creates the thread, and forwards to
// fn_send_message, which does the debit + escrow + release atomically.
// p_sender_id is always the authenticated caller's own id, never taken from
// the request body.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadOpenAiModerationConfig } from '../_shared/moderation-config.ts';
import { runInBackground, sendPushToUser } from '../_shared/push.ts';
import { createOpenAiModerationProvider } from '../../../packages/moderation/openai.ts';

interface SendMessageRequestBody {
  thread_id?: string;
  recipient_id?: string;
  body?: string;
  // Offline outbox replay key (docs/13-OFFLINE-MODE-SCOPING.md) — a client-
  // generated uuid, unique per composed message, that makes a retried send
  // safe after a dropped connection. Optional: every pre-offline-mode
  // caller omits it and behaves exactly as before.
  client_message_id?: string;
}

interface FnSendMessageRow {
  message_id: string;
  credits_charged: number;
  word_count: number;
  status: string;
  payer_balance_after: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Maps the `raise exception` messages fn_send_message can throw (see
// docs/00-SESSION-HANDOFF.md's "Immediate next step" error table) to HTTP
// responses. fn_start_thread only raises 'cannot_thread_with_self', which
// is pre-validated below before it's ever called.
function mapSendMessageError(pgMessage: string): Response {
  if (pgMessage.startsWith('thread_not_found')) {
    return errorResponse(404, 'thread_not_found', 'Thread does not exist.');
  }
  if (pgMessage.startsWith('not_a_participant')) {
    return errorResponse(403, 'not_a_participant', 'You are not a participant in this thread.');
  }
  if (pgMessage.startsWith('thread_blocked')) {
    return errorResponse(403, 'thread_blocked', 'This thread is blocked.');
  }
  if (pgMessage.startsWith('wallet_frozen')) {
    return errorResponse(403, 'wallet_frozen', 'Your wallet is frozen.');
  }
  if (pgMessage.startsWith('empty_message')) {
    return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
  }
  if (pgMessage.startsWith('message_too_long')) {
    return errorResponse(400, 'message_too_long', pgMessage);
  }
  if (pgMessage.startsWith('insufficient_credit')) {
    // fn_send_message raises 'insufficient_credit: need % have %'.
    const match = /need (\d+) have (\d+)/.exec(pgMessage);
    return json(402, {
      error: 'insufficient_credit',
      credits_required: match ? Number(match[1]) : null,
      credits_available: match ? Number(match[2]) : null,
    });
  }

  console.error('send-message: unmapped DB error:', pgMessage);
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
    console.error('send-message: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: SendMessageRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.body !== 'string' || payload.body.trim().length === 0) {
    return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
  }

  if (
    payload.client_message_id !== undefined &&
    (typeof payload.client_message_id !== 'string' || !UUID_RE.test(payload.client_message_id))
  ) {
    return errorResponse(400, 'invalid_request', 'client_message_id must be a UUID.');
  }

  let threadId = payload.thread_id;
  if (threadId !== undefined && (typeof threadId !== 'string' || !UUID_RE.test(threadId))) {
    return errorResponse(400, 'invalid_request', 'thread_id must be a UUID.');
  }

  const db = serviceRoleClient();

  if (!threadId) {
    const recipientId = payload.recipient_id;
    if (typeof recipientId !== 'string' || !UUID_RE.test(recipientId)) {
      return errorResponse(
        400,
        'invalid_request',
        'Provide an existing thread_id, or a recipient_id to start a new thread.',
      );
    }
    if (recipientId === user.id) {
      return errorResponse(400, 'invalid_request', 'Cannot start a thread with yourself.');
    }

    const { data: recipient, error: recipientError } = await db
      .from('users')
      .select('id')
      .eq('id', recipientId)
      .maybeSingle();
    if (recipientError) {
      console.error('send-message: recipient lookup failed:', recipientError.message);
      return errorResponse(500, 'internal_error', 'Something went wrong.');
    }
    if (!recipient) {
      return errorResponse(404, 'recipient_not_found', 'Recipient does not exist.');
    }

    // The thread's initiator becomes participant_a (payer) — consistent
    // with the worked example in docs/05-API-REALTIME-SPEC.md §4 where A
    // is always the payer who opens the conversation.
    const { data: newThreadId, error: startError } = await db.rpc('fn_start_thread', {
      p_payer_id: user.id,
      p_payee_id: recipientId,
    });
    if (startError) {
      console.error('send-message: fn_start_thread failed:', startError.message);
      return errorResponse(500, 'internal_error', 'Could not start thread.');
    }
    threadId = newThreadId as string;
  }

  // Content moderation (docs/06-SECURITY-FRAUD-LOOPHOLES.md §6,
  // docs/07-COMPLIANCE-LEGAL.md §3) — checked before fn_send_message, not
  // after: a hard block must never be charged or delivered, so it can
  // never reach the billing RPC at all. See packages/moderation/
  // provider.ts for the blocked-vs-flagged distinction. A flagged (not
  // blocked) result is logged further down, once the real message_id
  // exists to reference.
  let flaggedCategories: string[] | null = null;
  try {
    const moderation = await createOpenAiModerationProvider(
      loadOpenAiModerationConfig(),
    ).moderateText(payload.body);

    if (moderation.action === 'blocked') {
      await db.from('moderated_content').insert({
        user_id: user.id,
        content_type: 'message',
        action: 'blocked',
        categories: moderation.categories,
      });
      return errorResponse(
        400,
        'content_blocked',
        'This message violates our content policy and could not be sent.',
      );
    }
    if (moderation.action === 'flagged') {
      flaggedCategories = moderation.categories;
    }
  } catch (e) {
    // A moderation-provider outage must not take down messaging — fail
    // open (allow the send) rather than block every message in the app
    // because a third-party API had a bad moment. Logged loudly so a
    // sustained outage is visible in supabase functions logs.
    console.error('send-message: content moderation check failed, allowing send:', e);
  }

  const { data: rawData, error } = await db
    .rpc('fn_send_message', {
      p_thread_id: threadId,
      p_sender_id: user.id,
      p_body: payload.body,
      p_client_message_id: payload.client_message_id ?? null,
    })
    .single();

  if (error) {
    return mapSendMessageError(error.message);
  }

  const data = rawData as FnSendMessageRow;

  if (flaggedCategories) {
    await db.from('moderated_content').insert({
      user_id: user.id,
      content_type: 'message',
      ref_id: data.message_id,
      action: 'flagged',
      categories: flaggedCategories,
    });
  }

  // Push notification — best-effort, never blocks or fails the response
  // this billing-critical call already computed correctly. See
  // _shared/push.ts's header comment for why "off" has no dedicated flag
  // (it's just "no push_tokens row") and why this runs via
  // EdgeRuntime.waitUntil rather than being awaited inline.
  runInBackground(async () => {
    const { data: threadRow } = await db
      .from('threads')
      .select('participant_a, participant_b, muted_by_a, muted_by_b')
      .eq('id', threadId)
      .maybeSingle();
    if (!threadRow) return;

    const recipientIsA = threadRow.participant_a !== user.id;
    const recipientId = recipientIsA ? threadRow.participant_a : threadRow.participant_b;
    const recipientMutedThisThread = recipientIsA ? threadRow.muted_by_a : threadRow.muted_by_b;
    if (recipientMutedThisThread) return; // docs/10-UX-REFINEMENT-BACKLOG.md Batch G

    const { data: sender } = await db
      .from('users')
      .select('display_name')
      .eq('id', user.id)
      .maybeSingle();

    await sendPushToUser(
      db,
      recipientId,
      sender?.display_name ?? 'New message',
      payload.body!.length > 120 ? `${payload.body!.slice(0, 117)}...` : payload.body!,
      { thread_id: threadId },
    );
  });

  return json(200, {
    thread_id: threadId,
    message_id: data.message_id,
    credits_charged: data.credits_charged,
    word_count: data.word_count,
    status: data.status,
    payer_balance_after: data.payer_balance_after,
  });
});
