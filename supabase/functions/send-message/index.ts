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

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { E2eeEnvelopesArraySchema } from '../_shared/e2eeEnvelope.ts';
import { loadOpenAiModerationConfig } from '../_shared/moderation-config.ts';
import { runInBackground, sendPushToUser } from '../_shared/push.ts';
import { checkRateLimit } from '../_shared/rateLimit.ts';
import { parseBody } from '../_shared/validate.ts';

// Defense-in-depth (docs/19-SECURITY-HARDENING-SCOPING.md §3) — the natural
// cost-based throttle (insufficient_credit) already caps unfunded abuse;
// this bounds a funded account's raw call rate too, generously above any
// real chat pace.
const SEND_MESSAGE_MAX = 60;
const SEND_MESSAGE_WINDOW_SECONDS = 60;
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
  // The quoted message's id, for a WhatsApp-style reply — fn_send_message
  // validates this actually belongs to the target thread server-side, so
  // this being client-supplied carries no trust risk.
  reply_to_message_id?: string;
  // Display-only "Forwarded" tag (see this migration's own header comment
  // for why this never touches pricing). Omit/false for a normal send.
  is_forwarded?: boolean;
  // Chat media (docs/16-CHAT-MEDIA-SCOPING.md, docs/17-VOICE-NOTES-
  // SCOPING.md) — the `path` returned by create-chat-media-upload-url,
  // once the client's own upload to it has actually succeeded. `body` may
  // be empty/omitted when media_path is present (a captionless photo or a
  // voice note with no caption is a real message); fn_send_message is the
  // actual authority on that, and on media_path really having been issued
  // to this caller (CLAUDE.md rule #1 — never trust a client path string
  // on faith).
  media_path?: string;
  media_type?: string;
  // Voice notes only (docs/17 §3/§5) — display-only duration (never a
  // billing input; fn_send_message enforces the real max-duration cap
  // server-side) and the real recorded-amplitude waveform, bounds-checked
  // again below before ever reaching the RPC.
  duration_seconds?: number;
  waveform_samples?: number[];
  // Free status replies (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md
  // §B1) — the status being replied to. fn_send_message is the actual
  // authority on whether this send turns out free (its own first-message-
  // in-thread + no-media + real/unexpired/visible-status check) — this is
  // just carried through, never trusted as "this send is free" on faith.
  reply_to_status_id?: string;
  // Real end-to-end encryption (docs/21-E2EE-TECHNICAL-DESIGN.md §3, §4) —
  // required instead of `body` when this send targets an e2ee-active
  // thread; one entry per recipient device. Shape validated against
  // E2eeEnvelopesArraySchema once the thread's e2ee_status is known
  // (below) — a brand-new thread is always 'off' at creation, so this can
  // only ever matter for an existing thread_id.
  envelopes?: unknown;
}

interface FnSendMessageRow {
  message_id: string;
  credits_charged: number;
  word_count: number;
  status: string;
  payer_balance_after: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// This function's request body has a lot of cross-field conditional logic
// (media_type only matters if media_path is present, duration/waveform only
// matter if that media is audio, recipient_id needs an async DB lookup) that
// stays exactly as hand-written procedural code below — that's genuinely
// what it is, not ad hoc validation Zod would express more clearly. What
// Zod replaces here is the four independent, unconditional "is this
// optional field a well-formed UUID if present" checks
// (docs/19-SECURITY-HARDENING-SCOPING.md §4) — the actual sweet spot for a
// shape-validation schema, extracted so a future fifth UUID field can't
// forget the same check the way four hand-copied regex tests risked.
const uuidField = (name: string) =>
  z
    .string({ invalid_type_error: `${name} must be a UUID.` })
    .regex(UUID_RE, `${name} must be a UUID.`)
    .optional();
const SendMessageUuidFieldsSchema = z.object({
  thread_id: uuidField('thread_id'),
  client_message_id: uuidField('client_message_id'),
  reply_to_message_id: uuidField('reply_to_message_id'),
  reply_to_status_id: uuidField('reply_to_status_id'),
});

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
  if (pgMessage.startsWith('no_active_payer')) {
    return errorResponse(
      409,
      'no_active_payer',
      'No one is currently set to pay for this conversation.',
    );
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
  if (pgMessage.startsWith('invalid_reply_target')) {
    return errorResponse(400, 'invalid_reply_target', 'That message cannot be replied to.');
  }
  if (pgMessage.startsWith('invalid_media_path')) {
    return errorResponse(400, 'invalid_media_path', 'That media was not uploaded by you.');
  }
  if (pgMessage.startsWith('unsupported_media_type')) {
    return errorResponse(400, 'unsupported_media_type', 'Unsupported media type.');
  }
  if (pgMessage.startsWith('media_not_found')) {
    return errorResponse(400, 'media_not_found', 'That media was not found — try uploading again.');
  }
  if (pgMessage.startsWith('invalid_duration')) {
    return errorResponse(
      400,
      'invalid_duration',
      'duration_seconds must be a non-negative integer.',
    );
  }
  if (pgMessage.startsWith('audio_too_long')) {
    return errorResponse(400, 'audio_too_long', pgMessage);
  }
  if (pgMessage.startsWith('invalid_waveform_samples')) {
    return errorResponse(400, 'invalid_waveform_samples', 'waveform_samples values must be 0-100.');
  }
  if (pgMessage.startsWith('invalid_status_reply_target')) {
    return errorResponse(
      400,
      'invalid_status_reply_target',
      'That status is no longer available to reply to.',
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }
  if (typeof rawBody !== 'object' || rawBody === null) {
    return errorResponse(400, 'invalid_request', 'Body must be a JSON object.');
  }
  const payload = rawBody as SendMessageRequestBody;

  const uuidFields = parseBody(SendMessageUuidFieldsSchema, rawBody);
  if (!uuidFields.success) return uuidFields.response;

  const hasMedia = typeof payload.media_path === 'string' && payload.media_path.trim().length > 0;

  if (payload.body !== undefined && typeof payload.body !== 'string') {
    return errorResponse(400, 'invalid_request', 'body must be a string.');
  }
  const body = payload.body ?? '';
  // The "body (or media) must be non-empty" check used to run here
  // unconditionally, but an e2ee-active thread legitimately sends an
  // empty body (the real content is in `envelopes`) — that check is
  // deferred below, once the thread's e2ee_status is actually known.

  if (payload.media_path !== undefined && typeof payload.media_path !== 'string') {
    return errorResponse(400, 'invalid_request', 'media_path must be a string.');
  }
  if (hasMedia && payload.media_type !== 'image' && payload.media_type !== 'audio') {
    return errorResponse(400, 'unsupported_media_type', 'Unsupported media type.');
  }
  const isAudio = hasMedia && payload.media_type === 'audio';

  // Redundant with fn_send_message's own checks (CLAUDE.md rule #1 — the
  // DB function is the actual authority, not this), but rejecting a
  // malformed request here is a better error than a raw Postgres one for
  // the same class of mistake.
  if (isAudio) {
    if (
      typeof payload.duration_seconds !== 'number' ||
      !Number.isFinite(payload.duration_seconds) ||
      payload.duration_seconds < 0
    ) {
      return errorResponse(
        400,
        'invalid_duration',
        'duration_seconds must be a non-negative integer.',
      );
    }
    if (payload.waveform_samples !== undefined) {
      const samples = payload.waveform_samples;
      const valid =
        Array.isArray(samples) &&
        samples.length <= 64 &&
        samples.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100);
      if (!valid) {
        return errorResponse(
          400,
          'invalid_waveform_samples',
          'waveform_samples must be at most 64 numbers, each 0-100.',
        );
      }
    }
  }

  // client_message_id / reply_to_message_id / reply_to_status_id / thread_id
  // shape (well-formed UUID if present) is already validated above via
  // SendMessageUuidFieldsSchema.
  let threadId = payload.thread_id;

  const db = serviceRoleClient();

  const rateAllowed = await checkRateLimit(
    db,
    `send-message:user:${user.id}`,
    SEND_MESSAGE_MAX,
    SEND_MESSAGE_WINDOW_SECONDS,
  );
  if (!rateAllowed) {
    return errorResponse(429, 'rate_limited', 'Sending too fast — slow down a moment.');
  }

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

  // Real end-to-end encryption (docs/21-E2EE-TECHNICAL-DESIGN.md §3) — a
  // brand-new thread (just created above) is always 'off', so this only
  // ever matters for an existing thread_id. e2ee_status governs both
  // what shape this request must have (envelopes vs. body) and whether
  // moderation runs at all — there is no plaintext to moderate once
  // active.
  const { data: threadE2eeRow, error: threadE2eeError } = await db
    .from('threads')
    .select('e2ee_status')
    .eq('id', threadId)
    .maybeSingle();
  if (threadE2eeError) {
    console.error('send-message: e2ee_status lookup failed:', threadE2eeError.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }
  const isE2eeActive = threadE2eeRow?.e2ee_status === 'active';

  let envelopes: z.infer<typeof E2eeEnvelopesArraySchema> | null = null;
  if (isE2eeActive) {
    // Media is supported on e2ee-active threads (session 37/38) — the
    // client encrypts the file itself before upload and carries the
    // attachment key inside this same envelope (see fn_send_message's own
    // header comment for the full design). This function never needs to
    // know a request carries media any differently than a text-only one:
    // hasMedia/media_path/media_type/duration/waveform are already
    // validated identically for both cases inside fn_send_message itself.
    const envelopesParsed = parseBody(E2eeEnvelopesArraySchema, payload.envelopes);
    if (!envelopesParsed.success) return envelopesParsed.response;
    envelopes = envelopesParsed.data;
  } else if (body.trim().length === 0 && !hasMedia) {
    return errorResponse(400, 'empty_message', 'Message body cannot be empty.');
  }

  // Content moderation (docs/06-SECURITY-FRAUD-LOOPHOLES.md §6,
  // docs/07-COMPLIANCE-LEGAL.md §3) — checked before fn_send_message, not
  // after: a hard block must never be charged or delivered, so it can
  // never reach the billing RPC at all. See packages/moderation/
  // provider.ts for the blocked-vs-flagged distinction. A flagged (not
  // blocked) result is logged further down, once the real message_id
  // exists to reference. Skipped entirely for an e2ee-active thread
  // (docs/21 §3) — there is no plaintext here to read.
  let flaggedCategories: string[] | null = null;
  if (!isE2eeActive) {
    try {
      const moderationProvider = createOpenAiModerationProvider(loadOpenAiModerationConfig());
      const textModeration = await moderationProvider.moderateText(body);

      // Image moderation (docs/16-CHAT-MEDIA-SCOPING.md §5) — checked
      // separately from text, both before fn_send_message: either one
      // blocking is enough to block the whole message, same "never charged
      // or delivered" posture the text-only path already has. Downloads the
      // just-uploaded object with the service-role client (chat-media is
      // private; this bypasses its RLS the same way every other service-
      // role read in this codebase does) rather than trusting a client-
      // supplied mime type for what actually gets sent to OpenAI.
      //
      // Voice notes (docs/17-VOICE-NOTES-SCOPING.md §6) — transcribe first,
      // then run the transcript through the same moderateText the caller
      // above already used for the caption. Same "either one blocking is
      // enough" posture as image moderation; catches spoken-content abuse,
      // not non-speech audio abuse (a stated gap, not a silent one).
      let mediaModeration: { action: string; categories: string[] } = {
        action: 'clean',
        categories: [],
      };
      if (hasMedia && (payload.media_type === 'image' || payload.media_type === 'audio')) {
        const { data: mediaBlob, error: downloadError } = await db.storage
          .from('chat-media')
          .download(payload.media_path!);
        if (downloadError) {
          // The upload itself is verified server-side by fn_send_message's
          // own path-ownership check below; a download failure here means
          // moderation can't run, not that the send should be silently
          // skipped — fail open on the moderation check specifically (same
          // posture the catch block below already has for a provider
          // outage), not on the send itself.
          console.error('send-message: could not download media for moderation:', downloadError);
        } else if (payload.media_type === 'image') {
          const imageBytes = new Uint8Array(await mediaBlob.arrayBuffer());
          mediaModeration = await moderationProvider.moderateImage(
            imageBytes,
            mediaBlob.type || 'image/jpeg',
          );
        } else {
          const audioBytes = new Uint8Array(await mediaBlob.arrayBuffer());
          mediaModeration = await moderationProvider.moderateAudio(
            audioBytes,
            mediaBlob.type || 'audio/m4a',
          );
        }
      }

      const blocked = textModeration.action === 'blocked' || mediaModeration.action === 'blocked';
      const flagged =
        !blocked && (textModeration.action === 'flagged' || mediaModeration.action === 'flagged');
      const categories = [
        ...new Set([...textModeration.categories, ...mediaModeration.categories]),
      ];

      if (blocked) {
        await db.from('moderated_content').insert({
          user_id: user.id,
          content_type: 'message',
          action: 'blocked',
          categories,
        });
        return errorResponse(
          400,
          'content_blocked',
          'This message violates our content policy and could not be sent.',
        );
      }
      if (flagged) {
        flaggedCategories = categories;
      }
    } catch (e) {
      // A moderation-provider outage must not take down messaging — fail
      // open (allow the send) rather than block every message in the app
      // because a third-party API had a bad moment. Logged loudly so a
      // sustained outage is visible in supabase functions logs.
      console.error('send-message: content moderation check failed, allowing send:', e);
    }
  }

  const { data: rawData, error } = await db
    .rpc('fn_send_message', {
      p_thread_id: threadId,
      p_sender_id: user.id,
      p_body: isE2eeActive ? '' : body,
      p_client_message_id: payload.client_message_id ?? null,
      p_reply_to_message_id: payload.reply_to_message_id ?? null,
      p_is_forwarded: payload.is_forwarded ?? false,
      p_media_path: hasMedia ? payload.media_path : null,
      p_media_type: hasMedia ? payload.media_type : null,
      p_duration_seconds: isAudio ? payload.duration_seconds : null,
      p_waveform_samples: isAudio ? (payload.waveform_samples ?? null) : null,
      p_reply_to_status_id: payload.reply_to_status_id ?? null,
      p_envelopes: envelopes,
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

    // A captionless photo/voice note has nothing for the push body to
    // truncate — "📷 Photo" / "🎤 Voice message" match the same convention
    // WhatsApp's own notification text uses for a media-only message.
    // An e2ee-active send never has a plaintext `body` at all (the real
    // content lives only in envelopes this server never decrypts) — a
    // generic "🔒 New message" here isn't a fallback for a missing value,
    // it's the actual privacy-correct behavior: the push provider (APNs/
    // FCM) must never see this conversation's real content, same as this
    // server itself doesn't.
    const pushBody = isE2eeActive
      ? '🔒 New message'
      : body.trim().length
        ? body.length > 120
          ? `${body.slice(0, 117)}...`
          : body
        : isAudio
          ? '🎤 Voice message'
          : hasMedia
            ? '📷 Photo'
            : '';

    await sendPushToUser(db, recipientId, sender?.display_name ?? 'New message', pushBody, {
      type: 'new_message',
      thread_id: threadId,
    });
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
