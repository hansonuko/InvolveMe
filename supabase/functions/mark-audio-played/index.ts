// POST /functions/v1/mark-audio-played
//
// Wraps fn_mark_audio_played (migration 20260926110000_chat_audio_
// messages_pipeline.sql) — sets messages.audio_played_at the first time
// the recipient's own client actually starts playback of a voice note
// (docs/17-VOICE-NOTES-SCOPING.md §8). No financial logic here (CLAUDE.md
// rule #1): this is a lightweight, decorative read-state signal, parallel
// to (not replacing) the existing thread-wide read-receipt cursor.
// p_listener_id is always the authenticated caller's own id, never taken
// from the request body — same posture every other function here uses.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredUuid } from '../_shared/validate.ts';

const MarkAudioPlayedRequestSchema = z.object({
  message_id: requiredUuid('message_id'),
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

function mapError(pgMessage: string): Response {
  if (pgMessage.startsWith('message_not_found')) {
    return errorResponse(404, 'message_not_found', 'Message does not exist.');
  }
  if (pgMessage.startsWith('not_an_audio_message')) {
    return errorResponse(400, 'not_an_audio_message', 'This message is not a voice note.');
  }
  if (pgMessage.startsWith('cannot_mark_own_message_played')) {
    return errorResponse(
      400,
      'cannot_mark_own_message_played',
      "You can't mark your own message as played.",
    );
  }
  if (pgMessage.startsWith('not_a_participant')) {
    return errorResponse(403, 'not_a_participant', 'You are not part of this conversation.');
  }

  console.error('mark-audio-played: unmapped DB error:', pgMessage);
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
    console.error('mark-audio-played: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(MarkAudioPlayedRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_mark_audio_played', {
    p_message_id: payload.message_id,
    p_listener_id: user.id,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { ok: true });
});
