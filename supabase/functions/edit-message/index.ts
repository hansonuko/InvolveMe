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

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { E2eeEnvelopesArraySchema } from '../_shared/e2eeEnvelope.ts';
import { loadOpenAiModerationConfig } from '../_shared/moderation-config.ts';
import { parseBody } from '../_shared/validate.ts';
import { createOpenAiModerationProvider } from '../../../packages/moderation/openai.ts';

interface EditMessageRequestBody {
  message_id?: string;
  body?: string;
  // Real end-to-end encryption (docs/21-E2EE-TECHNICAL-DESIGN.md §3, §4) —
  // required instead of `body` when editing a message in an e2ee-active
  // thread. Double Ratchet has no "edit in place": this is a freshly
  // re-encrypted envelope per recipient device, same shape as a new send.
  envelopes?: unknown;
}

interface FnEditMessageRow {
  message_id: string;
  word_count: number;
  credits_charged: number;
  edited_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// body's own emptiness check keeps its distinct empty_message code (checked
// manually below, matching send-message's equivalent).
const EditMessageMessageIdSchema = z.object({
  message_id: z
    .string({ invalid_type_error: 'message_id must be a UUID.' })
    .regex(UUID_RE, 'message_id must be a UUID.'),
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
  if (pgMessage.startsWith('e2ee_envelopes_required')) {
    return errorResponse(
      400,
      'e2ee_envelopes_required',
      'This conversation is end-to-end encrypted — provide envelopes instead of a plaintext body.',
    );
  }
  if (pgMessage.startsWith('invalid_envelope_recipient_device')) {
    return errorResponse(
      400,
      'invalid_envelope_recipient_device',
      'One of the envelopes was addressed to a device that does not belong to the other person in this thread.',
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }
  if (typeof rawBody !== 'object' || rawBody === null) {
    return errorResponse(400, 'invalid_request', 'Body must be a JSON object.');
  }
  const rawPayload = rawBody as EditMessageRequestBody;

  const idParsed = parseBody(EditMessageMessageIdSchema, rawBody);
  if (!idParsed.success) return idParsed.response;
  const messageId = idParsed.data.message_id;

  const db = serviceRoleClient();

  // Real end-to-end encryption (docs/21-E2EE-TECHNICAL-DESIGN.md §3) —
  // whether this edit must carry envelopes (like a send) or a plaintext
  // body, and whether moderation runs at all, depends on the target
  // message's thread, not on which field the client happened to send
  // (a client-controlled signal here would let a malicious caller dodge
  // moderation on an 'off' thread just by sending `envelopes` instead of
  // `body`). If the message doesn't exist this read finds nothing and
  // falls through to fn_edit_message's own 'message_not_found', same as
  // before this lookup existed.
  const { data: messageThreadRow, error: messageThreadError } = await db
    .from('messages')
    .select('thread_id, threads(e2ee_status)')
    .eq('id', messageId)
    .maybeSingle();
  if (messageThreadError) {
    console.error('edit-message: thread e2ee_status lookup failed:', messageThreadError.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }
  const isE2eeActive =
    (messageThreadRow?.threads as { e2ee_status?: string } | null)?.e2ee_status === 'active';

  let body: string | null = null;
  let envelopes: z.infer<typeof E2eeEnvelopesArraySchema> | null = null;
  if (isE2eeActive) {
    const envelopesParsed = parseBody(E2eeEnvelopesArraySchema, rawPayload.envelopes);
    if (!envelopesParsed.success) return envelopesParsed.response;
    envelopes = envelopesParsed.data;
  } else {
    if (typeof rawPayload.body !== 'string' || rawPayload.body.trim().length === 0) {
      return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
    }
    body = rawPayload.body;
  }

  // Same moderation posture as send-message: a hard block never reaches
  // fn_edit_message, a flagged-but-allowed result is logged once the
  // call below succeeds. A moderation-provider outage fails open (allows
  // the edit) rather than blocking every edit in the app. Skipped
  // entirely for an e2ee-active thread (docs/21 §3) — there is no
  // plaintext here to read.
  let flaggedCategories: string[] | null = null;
  if (!isE2eeActive) {
    try {
      const moderation = await createOpenAiModerationProvider(
        loadOpenAiModerationConfig(),
      ).moderateText(body!);

      if (moderation.action === 'blocked') {
        await db.from('moderated_content').insert({
          user_id: user.id,
          content_type: 'message',
          ref_id: messageId,
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
  }

  const { data: rawData, error } = await db
    .rpc('fn_edit_message', {
      p_message_id: messageId,
      p_sender_id: user.id,
      p_new_body: body,
      p_envelopes: envelopes,
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
