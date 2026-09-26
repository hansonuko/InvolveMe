// POST /functions/v1/send-group-message
//
// Wraps fn_send_group_message_free (migration 20260918100000_free_group_
// messaging.sql) — deliberately NOT fn_send_group_message (docs/03-ECONOMY-
// LEDGER.md §10's paid, kill-switched model). Punch-list item 11: group
// chat ships free-to-send in this pass, since §10's own documented risk
// (an attacker colluding with one other member can cash out unlimited
// credit through a group with no reply-gate or per-message cap) is
// entirely a property of the *paid* path. This function never reads
// group_chat_enabled and never touches wallets/ledger_entries — there is
// nothing here for that risk to attach to. p_sender_id is always the
// authenticated caller's own id, never taken from the request body.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadOpenAiModerationConfig } from '../_shared/moderation-config.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';
import { createOpenAiModerationProvider } from '../../../packages/moderation/openai.ts';

interface SendGroupMessageRequestBody {
  group_thread_id?: string;
  body?: string;
  // Offline outbox replay key (docs/13-OFFLINE-MODE-SCOPING.md) — see
  // send-message/index.ts's identical field for the full rationale.
  client_message_id?: string;
  // Display-only "Forwarded" tag — see migration 20260920090000's header
  // comment for why this never affects billing (this path is free anyway).
  is_forwarded?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// body's own emptiness check keeps its distinct empty_message code (checked
// manually below, matching send-message's own equivalent), so this schema
// only covers group_thread_id and client_message_id.
const SendGroupMessageUuidFieldsSchema = z.object({
  group_thread_id: requiredString('group_thread_id'),
  client_message_id: z
    .string({ invalid_type_error: 'client_message_id must be a UUID.' })
    .regex(UUID_RE, 'client_message_id must be a UUID.')
    .optional(),
});

interface FnSendGroupMessageFreeRow {
  message_id: string;
  word_count: number;
  created_at: string;
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

// Maps fn_send_group_message_free's `raise exception` messages to HTTP
// responses, same convention mapSendMessageError/mapPostStatusError use.
function mapSendGroupMessageError(pgMessage: string): Response {
  if (pgMessage.startsWith('group_not_found')) {
    return errorResponse(404, 'group_not_found', 'This group no longer exists.');
  }
  if (pgMessage.startsWith('not_a_member')) {
    return errorResponse(403, 'not_a_member', 'You are not a member of this group.');
  }
  if (pgMessage.startsWith('empty_message')) {
    return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
  }
  if (pgMessage.startsWith('message_too_long')) {
    return errorResponse(400, 'message_too_long', pgMessage);
  }

  console.error('send-group-message: unmapped DB error:', pgMessage);
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
    console.error('send-group-message: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }
  if (typeof rawBody !== 'object' || rawBody === null) {
    return errorResponse(400, 'invalid_request', 'Body must be a JSON object.');
  }
  const rawPayload = rawBody as SendGroupMessageRequestBody;

  if (typeof rawPayload.body !== 'string' || rawPayload.body.trim().length === 0) {
    return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
  }
  const body = rawPayload.body;

  const uuidFields = parseBody(SendGroupMessageUuidFieldsSchema, rawBody);
  if (!uuidFields.success) return uuidFields.response;

  const payload = { ...rawPayload, body };

  const db = serviceRoleClient();

  // Content moderation (docs/06-SECURITY-FRAUD-LOOPHOLES.md §6) — same
  // posture send-message/post-status already use: checked before the DB
  // write, so a hard block is never delivered. A group message reaches
  // more people than a 1:1 one, so this matters here at least as much.
  let flaggedCategories: string[] | null = null;
  try {
    const moderation = await createOpenAiModerationProvider(
      loadOpenAiModerationConfig(),
    ).moderateText(payload.body);

    if (moderation.action === 'blocked') {
      await db.from('moderated_content').insert({
        user_id: user.id,
        content_type: 'group_message',
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
    // open, same as send-message/post-status.
    console.error('send-group-message: content moderation check failed, allowing send:', e);
  }

  const { data: rawData, error } = await db
    .rpc('fn_send_group_message_free', {
      p_group_thread_id: payload.group_thread_id,
      p_sender_id: user.id,
      p_body: payload.body,
      p_client_message_id: payload.client_message_id ?? null,
      p_is_forwarded: payload.is_forwarded ?? false,
    })
    .single();

  if (error) {
    return mapSendGroupMessageError(error.message);
  }

  const data = rawData as FnSendGroupMessageFreeRow;

  if (flaggedCategories) {
    await db.from('moderated_content').insert({
      user_id: user.id,
      content_type: 'group_message',
      ref_id: data.message_id,
      action: 'flagged',
      categories: flaggedCategories,
    });
  }

  return json(200, {
    message_id: data.message_id,
    word_count: data.word_count,
    created_at: data.created_at,
  });
});
