// POST /functions/v1/edit-message
//
// Punch-list item 2 (2026-09-19). No financial logic lives here (CLAUDE.md
// rule #1) — this function only authenticates the caller, runs the same
// content-moderation check send-message's own path already applies (an
// edit introduces new user-supplied text into the system, same as a
// fresh send), and forwards to fn_edit_message, which enforces every real
// rule (sender-only, escrowed-only, edit window, no-cost-increase) inside
// one row-locked transaction. p_sender_id is always the authenticated
// caller's own id, never taken from the request body — same posture
// every other money/message-adjacent function here already uses.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadOpenAiModerationConfig } from '../_shared/moderation-config.ts';
import { createOpenAiModerationProvider } from '../../../packages/moderation/openai.ts';

interface EditMessageRequestBody {
  message_id?: string;
  body?: string;
}

interface FnEditMessageRow {
  message_id: string;
  word_count: number;
  credits_charged: number;
  edited_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

// Maps fn_edit_message's `raise exception` messages to HTTP responses —
// same mapping shape send-message's own mapSendMessageError establishes.
function mapEditMessageError(pgMessage: string): Response {
  if (pgMessage.startsWith('message_not_found')) {
    return errorResponse(404, 'message_not_found', 'Message does not exist.');
  }
  if (pgMessage.startsWith('not_the_sender')) {
    return errorResponse(403, 'not_the_sender', 'You can only edit your own messages.');
  }
  if (pgMessage.startsWith('message_not_editable')) {
    return errorResponse(
      409,
      'message_not_editable',
      'This message can no longer be edited — the other person has already replied, or the message expired.',
    );
  }
  if (pgMessage.startsWith('edit_window_expired')) {
    return errorResponse(
      409,
      'edit_window_expired',
      'The time window for editing this message has passed.',
    );
  }
  if (pgMessage.startsWith('empty_message')) {
    return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
  }
  if (pgMessage.startsWith('message_too_long')) {
    return errorResponse(400, 'message_too_long', pgMessage);
  }
  if (pgMessage.startsWith('edit_would_increase_cost')) {
    return errorResponse(
      400,
      'edit_would_increase_cost',
      'This edit would make the message cost more credits than were already charged — send it as a new message instead.',
    );
  }

  console.error('edit-message: unmapped DB error:', pgMessage);
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
    console.error('edit-message: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: EditMessageRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.message_id !== 'string' || !UUID_RE.test(payload.message_id)) {
    return errorResponse(400, 'invalid_request', 'message_id must be a UUID.');
  }
  if (typeof payload.body !== 'string' || payload.body.trim().length === 0) {
    return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
  }

  const db = serviceRoleClient();

  // Same moderation posture as send-message: a hard block never reaches
  // fn_edit_message, a flagged-but-allowed result is logged once the
  // call below succeeds. A moderation-provider outage fails open (allows
  // the edit) rather than blocking every edit in the app.
  let flaggedCategories: string[] | null = null;
  try {
    const moderation = await createOpenAiModerationProvider(
      loadOpenAiModerationConfig(),
    ).moderateText(payload.body);

    if (moderation.action === 'blocked') {
      await db.from('moderated_content').insert({
        user_id: user.id,
        content_type: 'message',
        ref_id: payload.message_id,
        action: 'blocked',
        categories: moderation.categories,
      });
      return errorResponse(
        400,
        'content_blocked',
        'This message violates our content policy and could not be saved.',
      );
    }
    if (moderation.action === 'flagged') {
      flaggedCategories = moderation.categories;
    }
  } catch (e) {
    console.error('edit-message: content moderation check failed, allowing edit:', e);
  }

  const { data: rawData, error } = await db
    .rpc('fn_edit_message', {
      p_message_id: payload.message_id,
      p_sender_id: user.id,
      p_new_body: payload.body,
    })
    .single();

  if (error) {
    return mapEditMessageError(error.message);
  }

  const data = rawData as FnEditMessageRow;

  if (flaggedCategories) {
    await db.from('moderated_content').insert({
      user_id: user.id,
      content_type: 'message',
      ref_id: data.message_id,
      action: 'flagged',
      categories: flaggedCategories,
    });
  }

  return json(200, {
    message_id: data.message_id,
    word_count: data.word_count,
    credits_charged: data.credits_charged,
    edited_at: data.edited_at,
  });
});
