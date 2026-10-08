import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';

import { callEdgeFunction, EdgeFunctionError } from '@/lib/edgeFunctions';
import { bytesToBase64 } from '@/lib/e2ee/bytes';
import { decryptMediaBytes, type MediaKeyMaterial } from '@/lib/e2ee/mediaCrypto';
import { deleteCachedPlaintext, setCachedPlaintext } from '@/lib/e2ee/plaintextCache';
import { decryptThreadMessages, encryptForThread, type OutgoingEnvelope } from '@/lib/e2ee/session';
import { nativeSodiumProvider } from '@/lib/e2ee/sodiumProviderNative';
import { useRealtimeTableChanges } from '@/lib/realtimeChannel';
import { supabase } from '@/lib/supabase';

/** An e2ee media message's plaintext isn't a bare caption string — it's this
 * JSON shape (`{text, mediaKey, mediaNonce}`), so the attachment's symmetric
 * key can ride inside the same Double Ratchet envelope that already carries
 * the caption (see mediaCrypto.ts and fn_send_message's own header comment,
 * migration 20260929100000). Only ever used for a message that actually has
 * `media_path` set — a text-only e2ee message's plaintext stays a bare
 * string exactly as before, so this never risks misreading an existing
 * (pre-media-feature) message's decrypted body as JSON. */
interface E2eeMediaPlaintext {
  text: string;
  mediaKey: string;
  mediaNonce: string;
}

function encodeE2eeMediaPlaintext(text: string, keyMaterial: MediaKeyMaterial): string {
  return JSON.stringify({
    text,
    mediaKey: keyMaterial.keyBase64,
    mediaNonce: keyMaterial.nonceBase64,
  });
}

/** Inverse of encodeE2eeMediaPlaintext — only called once decryption of the
 * envelope itself already succeeded (never on the "🔒 Message unavailable"
 * fallback string, which isn't real JSON and shouldn't be parsed as if it
 * were). A parse failure here means a malformed/corrupt payload, not a
 * decrypt failure — falls back to an empty caption with no recoverable
 * media key, which the UI renders as a "media unavailable" state rather
 * than crashing. */
function decodeE2eeMediaPlaintext(raw: string): {
  body: string;
  mediaKey?: string;
  mediaNonce?: string;
} {
  try {
    const parsed = JSON.parse(raw) as Partial<E2eeMediaPlaintext>;
    return {
      body: typeof parsed.text === 'string' ? parsed.text : '',
      mediaKey: typeof parsed.mediaKey === 'string' ? parsed.mediaKey : undefined,
      mediaNonce: typeof parsed.mediaNonce === 'string' ? parsed.mediaNonce : undefined,
    };
  } catch {
    return { body: '' };
  }
}

/** Shown in place of an e2ee message this device cannot decrypt.
 *
 * Matches WhatsApp's own wording for the same state, deliberately: the
 * padlock-prefixed "🔒 Message unavailable" this used to render read as a
 * permanent failure and, worse, made ordinary encrypted chats look broken to
 * both people in them (real user report). A message lands here when its
 * ratchet keys are genuinely gone for this device — one-shot by construction,
 * so nothing is retried behind this string; it names the situation plainly
 * instead of implying a fault with the conversation. */
const UNDECRYPTABLE_MESSAGE_PLACEHOLDER = 'Waiting for this message. This may take a while.';

/** Turns this device's locally-cached plaintext for an e2ee message into the
 * one-line preview the chat list shows, mirroring how a plaintext thread's
 * own last message is summarized there.
 *
 * Lives here, next to encodeE2eeMediaPlaintext, because the cached string for
 * a media message is that function's JSON envelope rather than bare caption
 * text — the chat list has no business knowing that shape, so it asks for a
 * preview instead of parsing one. Returns `null` when there is nothing
 * meaningful to show, which the caller renders as the generic encrypted
 * placeholder. */
export function previewFromCachedPlaintext(
  cached: string,
  mediaType: string | null,
): string | null {
  if (mediaType === 'image' || mediaType === 'audio') {
    const label = mediaType === 'image' ? '📷 Photo' : '🎤 Voice message';
    const caption = decodeE2eeMediaPlaintext(cached).body.trim();
    return caption ? `${label}: ${caption}` : label;
  }
  return cached.trim() || null;
}

/** `fn_send_message`/`fn_edit_message`'s `p_envelopes` shape (docs/21-E2EE-TECHNICAL-DESIGN.md §3) — the wire/RPC field names, snake_case, distinct from OutgoingEnvelope's camelCase in-app shape. */
function envelopesForRpc(envelopes: OutgoingEnvelope[]) {
  return envelopes.map((e) => ({
    recipient_device_id: e.recipientDeviceId,
    ciphertext: e.ciphertext,
    ratchet_public_key: e.ratchetPublicKey,
    previous_chain_length: e.previousChainLength,
    message_number: e.messageNumber,
    x3dh_sender_identity_key: e.x3dhSenderIdentityKey,
    x3dh_sender_ephemeral_key: e.x3dhSenderEphemeralKey,
    x3dh_one_time_prekey_id: e.x3dhOneTimePrekeyId,
  }));
}

export interface Message {
  id: string;
  thread_id: string;
  sender_id: string;
  /** null-by-design for an e2ee-active thread's message (docs/21 §2) — the
   * real content lives only in e2ee_message_envelopes. useThreadMessages'
   * own decrypt path always resolves this to a real string (the decrypted
   * plaintext, or a "🔒 Message unavailable" fallback) before a Message
   * ever reaches a component — but the type stays honest about the raw
   * possibility rather than lying `string`, which is exactly what let a
   * real crash (MessageBubble's unconditional `.trim()`, session 37) go
   * uncaught by the type checker. */
  body: string | null;
  word_count: number;
  credits_charged: number;
  /** `'sent'` (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1) is a
   * genuinely free message — no escrow ever existed for it, so it never
   * transitions to 'released'/'refunded' the way an 'escrowed' one does. */
  status: 'escrowed' | 'released' | 'refunded' | 'sent';
  created_at: string;
  /** Set once by `fn_edit_message` on a successful edit, never cleared —
   * `null` means never edited. A timestamp rather than a plain boolean so
   * a future "edited Xm ago" detail needs no schema change (docs/02-DATA-
   * MODEL.md). Only ever set while the message was still `escrowed`; see
   * `useEditMessage`'s own comment for why editing stops being possible
   * once a message settles. */
  edited_at: string | null;
  /** Set by `fn_delete_message_for_everyone` (punch-list item 5,
   * 2026-09-19) — once true, `body` has been overwritten to empty
   * server-side and the client should render a "This message was
   * deleted" tombstone instead, never the (already-gone) body text. */
  deleted_for_everyone: boolean;
  /** The real moment the recipient first read this specific message —
   * stamped once by `fn_mark_thread_read` (`read_at is null` guard, never
   * overwritten after) and `null` until then. Fixes a real bug where the
   * displayed read time was derived live from the thread-wide read
   * cursor, so an older message's shown time kept jumping forward to
   * match the cursor's latest value every time the partner reopened the
   * thread — this is frozen per-message from the moment it's first read. */
  read_at: string | null;
  /** The quoted message's id, for a WhatsApp-style reply preview —
   * resolved against this same thread's already-loaded `messages` array
   * client-side (no extra query), since every message in a thread is
   * already in memory once the thread screen has loaded. `null` for an
   * ordinary (non-reply) message. */
  reply_to_message_id: string | null;
  /** Renders a small "Forwarded" tag — display-only, never a pricing
   * signal (see migration 20260920090000's header comment). */
  is_forwarded: boolean;
  /** docs/16-CHAT-MEDIA-SCOPING.md — a private `chat-media` object path,
   * never a public URL; resolve via `useChatMediaUrl` before rendering.
   * `null` for a text-only message. Cleared (along with `media_type`) by
   * `fn_delete_message_for_everyone` on delete. */
  media_path: string | null;
  /** `'image'` or `'audio'` (docs/17-VOICE-NOTES-SCOPING.md) — the column
   * exists ahead of a future video follow-up (docs/16 §4) too, not a sign
   * one is imminent. */
  media_type: string | null;
  /** docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1 — the status this
   * message replied to, if any. Only ever drives display (a "replied to
   * your status" preview); whether the send was actually free is read off
   * `credits_charged`/`status` above, never inferred from this being set. */
  reply_to_status_id: string | null;
  /** Audio-only, display-only — never read by billing logic
   * (docs/17 §3). `null` for every non-audio message. */
  duration_seconds: number | null;
  /** Real amplitude samples captured while recording (docs/17 §5), 0-100
   * each, at most 64 elements (server-enforced) — the bubble renders this
   * directly, never a decorative/random placeholder. `null` for every
   * non-audio message. */
  waveform_samples: number[] | null;
  /** Set once, by `fn_mark_audio_played`, the first time the RECIPIENT's
   * client actually starts playback — a lightweight read-state signal
   * parallel to (not replacing) the read-receipt double-tick. `null`
   * means unplayed (or not audio at all). */
  audio_played_at: string | null;
  /** Only ever set for an e2ee-active thread's media message, and only once
   * this device has successfully decrypted its envelope (docs/21 §5 follow-
   * up, session 37/38) — the per-attachment symmetric key/nonce
   * (mediaCrypto.ts) needed to decrypt the ciphertext actually sitting at
   * `media_path`. `undefined` for every non-e2ee message (the file at
   * media_path is already plaintext, nothing to decrypt) and for an e2ee
   * media message this device couldn't decrypt (same "🔒 Message
   * unavailable" case as a text message's body, extended to media: no key
   * recovered means no attempt to fetch/decrypt the attachment either). */
  e2eeMediaKeyBase64?: string;
  e2eeMediaNonceBase64?: string;
}

/** Messages in a thread, oldest first, kept live via Realtime Broadcast —
 * per docs/05-API-REALTIME-SPEC.md §3 and docs/01-ARCHITECTURE.md §4
 * (topic `messages:<thread_id>`, authorized via RLS on
 * `realtime.messages` rather than a postgres_changes filter — see
 * 20261008120000_realtime_broadcast_migration.sql). Presence/typing-
 * indicator/read-receipt channels from that same section aren't
 * implemented here — flagged as a deliberate v1 gap, not an oversight.
 *
 * `currentUserId` filters out anything the caller has personally deleted
 * (message_deletions, punch-list item 5) — a second, separate query
 * rather than a PostgREST embed/join, same "simpler to read than an
 * embed" call this file's other hooks already make; an acceptable extra
 * round trip since Realtime already refetches this wholesale on any
 * change, not per-keystroke. */
export function useThreadMessages(
  threadId: string | undefined,
  currentUserId: string | undefined,
  e2eeStatus?: 'off' | 'active',
) {
  const queryClient = useQueryClient();
  // e2eeStatus is part of the key, not just a closure value the queryFn
  // reads — it resolves asynchronously (useThreadHeaderInfo, a separate,
  // slower fetch) and typically starts `undefined` on first mount, before
  // this query's own `enabled` gate (threadId + currentUserId only) lets
  // it fire. Without e2eeStatus in the key, that first fetch can run with
  // `e2eeStatus === undefined`, skip the decrypt/fallback branch entirely
  // (`e2eeStatus !== 'active'` short-circuits it), and cache raw
  // `body: null` rows for a thread that's actually e2ee-active — which
  // TanStack Query then has no reason to ever refetch, since nothing
  // about the key changed once e2eeStatus later resolves to 'active'.
  // Found live (session 37) as a real crash: MessageBubble assumes
  // `message.body` is always a string and calls `.trim()` on it
  // unconditionally, which throws on a null body that slipped through
  // this exact race. Keying on e2eeStatus forces a genuine refetch (with
  // the correct decrypt/fallback branch) the moment it resolves, instead
  // of silently keeping the wrong cached result.
  const queryKey = ['messages', threadId, e2eeStatus];

  const query = useQuery({
    queryKey,
    enabled: !!threadId && !!currentUserId,
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from('messages')
        .select(
          'id, thread_id, sender_id, body, word_count, credits_charged, status, created_at, edited_at, deleted_for_everyone, read_at, reply_to_message_id, is_forwarded, media_path, media_type, reply_to_status_id, duration_seconds, waveform_samples, audio_played_at',
        )
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      if (!data?.length) return [];

      const { data: deletions, error: deletionsError } = await supabase
        .from('message_deletions')
        .select('message_id')
        .eq('user_id', currentUserId as string)
        .in(
          'message_id',
          data.map((m) => m.id),
        );
      if (deletionsError) throw deletionsError;

      const deletedIds = new Set((deletions ?? []).map((d) => d.message_id));
      const visible = data.filter((m) => !deletedIds.has(m.id));

      if (e2eeStatus !== 'active') return visible;

      // Real end-to-end encryption (docs/21-E2EE-TECHNICAL-DESIGN.md §5) —
      // a message actually needs decrypting only if THIS message's own
      // body is null, never just because the THREAD's current e2ee_status
      // is 'active'. e2ee_status is a one-way switch on the thread, not a
      // per-message fact: a thread's history from before encryption was
      // turned on is real plaintext with a real (non-null) body, stored
      // and returned exactly as any other message always has been.
      // fn_send_message only ever nulls `body` inside its own e2ee branch
      // (migration 20260926170000), so `body === null` is the reliable,
      // message-level signal this needs, not the thread-level flag.
      // Previously this ran decryptThreadMessages over EVERY message once
      // a thread went active, including years of real plaintext history —
      // decryptThreadMessages correctly found no envelope for any of it
      // (there never was one) and every one of those messages rendered as
      // "🔒 Message unavailable," permanently hiding real conversation
      // history the moment e2ee was enabled (session 37/38 bug report:
      // "all messages sent and received are showing message unavailable").
      const needsDecrypt = visible.filter((m) => m.body === null);
      if (needsDecrypt.length === 0) return visible;

      const decrypted = await decryptThreadMessages(
        threadId as string,
        currentUserId as string,
        needsDecrypt,
      );
      return visible.map((m) => {
        if (m.body !== null) return m;
        const raw = decrypted.get(m.id);
        if (raw === undefined) return { ...m, body: UNDECRYPTABLE_MESSAGE_PLACEHOLDER };
        if (!m.media_path) return { ...m, body: raw };
        const { body, mediaKey, mediaNonce } = decodeE2eeMediaPlaintext(raw);
        return { ...m, body, e2eeMediaKeyBase64: mediaKey, e2eeMediaNonceBase64: mediaNonce };
      });
    },
  });

  useRealtimeTableChanges(
    threadId ? `messages:${threadId}` : undefined,
    { event: '*', schema: 'public', table: 'messages', filter: `thread_id=eq.${threadId}` },
    (payload) => {
      // Patch the already-loaded list in place instead of refetching the
      // whole thread on every event (an INSERT for a brand-new message, an
      // UPDATE for a read-receipt flip or escrow release, ...) — a full
      // network round trip per event is exactly why messages used to lag
      // noticeably behind WhatsApp's own instant feel. `payload.new`/`.old`
      // already carry the complete row (Realtime sends every column, not
      // just the ones this file's own `select()` lists), so no follow-up
      // fetch is needed for INSERT/UPDATE. Falls back to a plain
      // `undefined` no-op if the cache hasn't been populated yet (e.g. an
      // event racing the initial `queryFn` before it's ever run) — the
      // query itself will pick the row up naturally once it does.
      if (payload.eventType === 'INSERT') {
        const row = payload.new as unknown as Message;
        if (e2eeStatus === 'active' && currentUserId) {
          // `row.body` is always null here (docs/21 §2) — resolve it the
          // same way the initial fetch does before the row ever reaches
          // the cache, so a live-arriving message never flashes/stays
          // unreadable while some other re-render happens to trigger a
          // refetch.
          decryptThreadMessages(threadId as string, currentUserId, [row]).then((decrypted) => {
            const raw = decrypted.get(row.id);
            const resolvedRow =
              raw === undefined
                ? { ...row, body: UNDECRYPTABLE_MESSAGE_PLACEHOLDER }
                : row.media_path
                  ? (() => {
                      const { body, mediaKey, mediaNonce } = decodeE2eeMediaPlaintext(raw);
                      return {
                        ...row,
                        body,
                        e2eeMediaKeyBase64: mediaKey,
                        e2eeMediaNonceBase64: mediaNonce,
                      };
                    })()
                  : { ...row, body: raw };
            queryClient.setQueryData<Message[]>(queryKey, (old) => {
              if (!old) return old;
              if (old.some((m) => m.id === resolvedRow.id)) return old;
              return [...old, resolvedRow].sort((a, b) => a.created_at.localeCompare(b.created_at));
            });
          });
          return;
        }
        queryClient.setQueryData<Message[]>(queryKey, (old) => {
          if (!old) return old;
          if (old.some((m) => m.id === row.id)) return old;
          return [...old, row].sort((a, b) => a.created_at.localeCompare(b.created_at));
        });
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new as unknown as Message;
        queryClient.setQueryData<Message[]>(queryKey, (old) =>
          old?.map((m) =>
            m.id === row.id
              ? // e2ee threads: `row.body` is always null (docs/21 §2) —
                // an UPDATE here is a status/read-receipt/edit-flag change,
                // never a real content change to apply; keep whatever body
                // this device already resolved rather than clobbering it
                // back to null.
                e2eeStatus === 'active'
                ? { ...m, ...row, body: m.body }
                : { ...m, ...row }
              : m,
          ),
        );
      } else if (payload.eventType === 'DELETE') {
        const oldRow = payload.old as { id?: string };
        if (!oldRow.id) return;
        const deletedId = oldRow.id;
        queryClient.setQueryData<Message[]>(queryKey, (old) =>
          old?.filter((m) => m.id !== deletedId),
        );
      }
    },
  );

  return query;
}

export interface SharedLink {
  url: string;
  messageId: string;
  createdAt: string;
}

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

/** Extracts URLs out of a batch of message bodies, most-recent-first,
 * de-duplicated by URL (keeping the most recent occurrence). Not a
 * TanStack Query hook's own field — this is pure text processing over data
 * `useThreadSharedLinks` already fetched, split out only so it's testable
 * without a Supabase round-trip. */
function extractSharedLinks(
  rows: { id: string; body: string; created_at: string }[],
): SharedLink[] {
  const seen = new Set<string>();
  const links: SharedLink[] = [];
  for (const row of rows) {
    const matches = row.body.match(URL_PATTERN);
    if (!matches) continue;
    for (const raw of matches) {
      // Trim common trailing punctuation a sentence would leave attached
      // ("check out https://example.com." or "(https://example.com)").
      const url = raw.replace(/[).,!?;:'"]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      links.push({ url, messageId: row.id, createdAt: row.created_at });
    }
  }
  return links;
}

/** "Shared links" for a thread's contact-info screen. Chat now has a real
 * photo pipeline (docs/16-CHAT-MEDIA-SCOPING.md) — a shared-media grid
 * equivalent to WhatsApp's own is a natural follow-up this doesn't
 * attempt; this stays scoped to links only, same as before that shipped.
 * A one-shot fetch, not kept live via
 * Realtime — this is a secondary contact-info panel, not the active chat
 * view, so it doesn't need `useThreadMessages`' subscription cost. */
export function useThreadSharedLinks(threadId: string | undefined) {
  return useQuery({
    queryKey: ['threadSharedLinks', threadId],
    enabled: !!threadId,
    queryFn: async (): Promise<SharedLink[]> => {
      const { data, error } = await supabase
        .from('messages')
        .select('id, body, created_at')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return extractSharedLinks(data ?? []);
    },
  });
}

interface SendMessageRequest {
  threadId?: string;
  recipientId?: string;
  body: string;
  /** Offline outbox replay key (docs/13-OFFLINE-MODE-SCOPING.md) — omit for
   * a normal online send; the outbox drain (lib/outboxDrain.ts) passes the
   * same uuid the message was queued under on every retry. */
  clientMessageId?: string;
  /** WhatsApp-style reply — the quoted message's id. Validated server-side
   * against the target thread. */
  replyToMessageId?: string;
  /** Display-only "Forwarded" tag — see the Message interface's own field
   * for why this never affects billing. */
  isForwarded?: boolean;
  /** docs/16-CHAT-MEDIA-SCOPING.md — the `path` returned by
   * useCreateChatMediaUploadUrl, once uploadChatMedia has actually
   * succeeded against it. `body` may be empty when this is set (a
   * captionless photo is a real message) — fn_send_message is the real
   * authority on both that and on this path actually having been issued
   * to the caller. */
  mediaPath?: string;
  mediaType?: string;
  /** docs/17-VOICE-NOTES-SCOPING.md §3/§8 — required alongside `mediaPath`/
   * `mediaType: 'audio'`; `fn_send_message` enforces both the max-duration
   * cap and the waveform array's bounds server-side, this is display data
   * plus the one billing-adjacent number (duration itself is never what's
   * billed — see docs/17 §3 — only whether it's under the cap). */
  durationSeconds?: number;
  waveformSamples?: number[];
  /** docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1 — the status
   * being replied to. fn_send_message is the real authority on whether
   * this turns out free (first-message-in-thread + no media + a real,
   * unexpired, visible status) — this is just carried through. */
  replyToStatusId?: string;
  /** Real end-to-end encryption (docs/21-E2EE-TECHNICAL-DESIGN.md §5) —
   * pass the thread's current `e2ee_status` and (whenever it's `'active'`)
   * the other participant's user id, so this mutation can encrypt `body`
   * into per-device envelopes instead of sending it as plaintext. A
   * brand-new thread (no `threadId` yet) is always `'off'` — omit both
   * for that case. */
  e2eeStatus?: 'off' | 'active';
  partnerId?: string;
  /** Set only when this send carries media on an e2ee-active thread — the
   * key/nonce `encryptMediaBytes` (mediaCrypto.ts) generated for the
   * attachment, which the caller already used to encrypt the file's bytes
   * and upload the ciphertext to `mediaPath` via `uploadEncryptedChatMedia`
   * BEFORE calling this mutation. Embedded into the envelope's own
   * plaintext alongside `body` (see encodeE2eeMediaPlaintext) rather than
   * sent any other way — this is the only channel the recipient's key
   * material ever travels through. */
  e2eeMediaKey?: MediaKeyMaterial;
}

interface SendMessageResponse {
  thread_id: string;
  message_id: string;
  credits_charged: number;
  word_count: number;
  status: string;
  payer_balance_after: number;
}

/** The `{ error: 'insufficient_credit', credits_required, credits_available }`
 * shape `send-message` returns on a 402 — surfaced via `EdgeFunctionError.
 * details` so the thread screen's no-credit prompt can show/auto-retry
 * against the real required amount instead of guessing at it. */
export interface InsufficientCreditDetails {
  error: 'insufficient_credit';
  credits_required: number;
  credits_available: number;
}

/** Wraps POST /functions/v1/send-message — the only place a message ever
 * gets sent from. No cost/credit computation here (CLAUDE.md rule #1); the
 * response's `credits_charged`/`payer_balance_after` are display-only,
 * already computed server-side. Typed `EdgeFunctionError` (not the default
 * `Error`) so callers can branch on `.code`/`.details` — the thread
 * screen's no-credit prompt is the first caller that needs to. */
export function useSendMessage() {
  const queryClient = useQueryClient();

  return useMutation<SendMessageResponse, EdgeFunctionError, SendMessageRequest>({
    mutationFn: async (request: SendMessageRequest) => {
      let envelopes: ReturnType<typeof envelopesForRpc> | undefined;
      if (request.e2eeStatus === 'active') {
        if (!request.threadId || !request.partnerId) {
          throw new Error('useSendMessage: an active-e2ee send needs both threadId and partnerId.');
        }
        const plaintext = request.e2eeMediaKey
          ? encodeE2eeMediaPlaintext(request.body, request.e2eeMediaKey)
          : request.body;
        const outgoing = await encryptForThread(request.threadId, request.partnerId, plaintext);
        envelopes = envelopesForRpc(outgoing);
      }

      return callEdgeFunction<SendMessageResponse>('send-message', {
        thread_id: request.threadId,
        recipient_id: request.recipientId,
        body: envelopes ? '' : request.body,
        client_message_id: request.clientMessageId,
        reply_to_message_id: request.replyToMessageId,
        is_forwarded: request.isForwarded,
        media_path: request.mediaPath,
        media_type: request.mediaType,
        duration_seconds: request.durationSeconds,
        waveform_samples: request.waveformSamples,
        reply_to_status_id: request.replyToStatusId,
        envelopes,
      });
    },
    onSuccess: async (data, variables) => {
      if (variables.e2eeStatus === 'active') {
        // The sender already has the plaintext it just typed — no
        // envelope exists addressed to itself to decrypt later (docs/21
        // §2), so this is the ONLY chance to make this device's own copy
        // of its own sent message survive past the current session. Must
        // land before the Realtime INSERT this same send triggers tries
        // to resolve the same message id — in practice always true (this
        // callback fires off the same HTTP response the DB insert that
        // triggers Realtime already committed before returning), but not
        // a hard guarantee; decryptThreadMessages checks this cache
        // first regardless, so a loss here just means a one-time "🔒
        // Message unavailable" for this device's own bubble until the
        // next real fetch, never corrupted content.
        const cachedPlaintext = variables.e2eeMediaKey
          ? encodeE2eeMediaPlaintext(variables.body, variables.e2eeMediaKey)
          : variables.body;
        await setCachedPlaintext(data.message_id, cachedPlaintext);
      }

      // Deliberately no `invalidateQueries(['messages', ...])` here — the
      // just-sent row lands in the thread's message cache via the same
      // Realtime INSERT patch every other participant's client relies on
      // (see useThreadMessages above), so refetching the whole thread on
      // top of that would just be a redundant network round trip on every
      // single send, the opposite of the "feel instant" fix this was
      // written for. `thread/[id].tsx`'s own optimistic bubble covers the
      // brief gap before that patch lands, with a self-healing fallback
      // refetch if it ever doesn't.
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });
}

interface CreateChatMediaUploadUrlResponse {
  path: string;
  token: string;
  signed_url: string;
}

/** Wraps POST /functions/v1/create-chat-media-upload-url — mints a
 * one-time signed upload slot in the private `chat-media` bucket, same
 * shape as status's own `useCreateStatusUploadUrl`
 * (lib/queries/status.ts). `kind` defaults to `'image'` server-side
 * (docs/17-VOICE-NOTES-SCOPING.md §8) — omit it for the existing photo
 * flow, pass `'audio'` for a voice note; it drives the returned path's
 * file extension and, implicitly, which `media_type` the caller is
 * expected to send next. */
export function useCreateChatMediaUploadUrl() {
  return useMutation({
    mutationFn: (kind?: 'image' | 'audio') =>
      callEdgeFunction<CreateChatMediaUploadUrlResponse>('create-chat-media-upload-url', {
        kind,
      }),
  });
}

/** Uploads a local file (camera capture or gallery pick, already resized/
 * compressed by the caller — see components/chat/ChatMediaComposer.tsx) to
 * the path a signed upload URL was minted for. Identical Blob-rewrapping
 * approach to status's own `uploadStatusMedia` — see that function's
 * detailed comment for why this exact construction (`new Blob([original],
 * { type })`, not `fileOptions.contentType`, not a raw ArrayBuffer) is the
 * one that actually works on-device, not a stylistic choice. */
export async function uploadChatMedia(localUri: string, path: string, token: string) {
  const response = await fetch(localUri);
  const original = await response.blob();
  const blob = new Blob([original], { type: 'image/jpeg' });
  const { error } = await supabase.storage.from('chat-media').uploadToSignedUrl(path, token, blob);
  if (error) throw error;
}

/** Same Blob-rewrapping approach as `uploadChatMedia` (docs/17-VOICE-
 * NOTES-SCOPING.md §10) — `.type` is what the signed-URL upload actually
 * respects, not `fileOptions.contentType`. `audio/m4a` matches
 * `create-chat-media-upload-url`'s own `kind: 'audio'` extension choice
 * and the bucket's widened `allowed_mime_types`
 * (20260926110000_chat_audio_messages_pipeline.sql) — expo-audio's
 * default recording preset produces an `.m4a`/AAC container. */
export async function uploadChatAudio(localUri: string, path: string, token: string) {
  const response = await fetch(localUri);
  const original = await response.blob();
  const blob = new Blob([original], { type: 'audio/m4a' });
  const { error } = await supabase.storage.from('chat-media').uploadToSignedUrl(path, token, blob);
  if (error) throw error;
}

/** Reads a local capture/pick's raw bytes off-device, before encryption, so
 * the e2ee path can encrypt them (mediaCrypto.ts's encryptMediaBytes) instead
 * of uploading the plaintext file directly.
 *
 * Uses expo-file-system's `File` rather than the `fetch(localUri).blob()`
 * shape the plaintext upload helpers above use, because React Native's Blob
 * is a polyfill (`Libraries/Blob/Blob.js`) that implements only `slice()` —
 * it has no `arrayBuffer()` and no `text()`, unlike a web Blob. Calling
 * `blob.arrayBuffer()` here therefore threw a bare "undefined is not a
 * function" on every single e2ee media send, voice notes and photos alike
 * (real bug report; the generic error text is why it read as a crypto
 * failure rather than a file-read one). `File` is a real native-backed
 * implementation and its `arrayBuffer()` actually exists. */
export async function readLocalFileBytes(localUri: string): Promise<Uint8Array> {
  return new Uint8Array(await new File(localUri).arrayBuffer());
}

/** Uploads an already-encrypted attachment (mediaCrypto.ts's
 * encryptMediaBytes output) to a signed upload slot — the e2ee counterpart
 * to `uploadChatMedia`/`uploadChatAudio`, which upload a file's real bytes
 * unchanged. `application/octet-stream` is the only honest Content-Type for
 * opaque ciphertext (migration 20260929100000 widened the bucket's
 * allowed_mime_types for exactly this) — it is never a valid JPEG/PNG/M4A
 * once encrypted, so claiming one of those types here would be a lie this
 * app has no reason to tell since every e2ee attachment is decrypted before
 * it's ever rendered anyway.
 *
 * Routes the ciphertext through a temp file rather than
 * `new Blob([ciphertext], ...)` directly — React Native's own Blob polyfill
 * (`BlobManager.createFromParts`) explicitly throws on ArrayBuffer/
 * ArrayBufferView parts (see uploadStatusMedia's header comment,
 * lib/queries/status.ts, for the prior real bug this exact constraint
 * caused); only wrapping an existing Blob works on-device. Writing to a
 * temp file via expo-file-system's File API and then `fetch(file://...)
 * .blob()` reuses the identical, already-proven local-file-to-Blob path
 * every other upload in this app already relies on, rather than a second,
 * novel construction. */
export async function uploadEncryptedChatMedia(
  ciphertext: Uint8Array,
  path: string,
  token: string,
) {
  const tempFile = new File(Paths.cache, `e2ee-upload-${Crypto.randomUUID()}.bin`);
  try {
    tempFile.create({ overwrite: true });
    tempFile.write(ciphertext);
    const response = await fetch(tempFile.uri);
    const original = await response.blob();
    const blob = new Blob([original], { type: 'application/octet-stream' });
    const { error } = await supabase.storage
      .from('chat-media')
      .uploadToSignedUrl(path, token, blob);
    if (error) throw error;
  } finally {
    try {
      tempFile.delete();
    } catch {
      // Best-effort cleanup — the cache directory is OS-reclaimed anyway,
      // so a failure here is never worth surfacing over the upload itself.
    }
  }
}

/** Signed read URL for a chat-media object — the bucket is private, so
 * this is the only way to actually display one. Fails (throws) if the
 * caller isn't a participant in the owning message's thread, per
 * `chat_media_select_visible` RLS
 * (20260925120000_chat_media_pipeline.sql). Cached for an hour, same as
 * status's own `useStatusMediaUrl` — a chat photo doesn't change once
 * sent, so there's nothing to invalidate this on. */
export function useChatMediaUrl(mediaPath: string | null) {
  return useQuery({
    queryKey: ['chatMediaUrl', mediaPath],
    enabled: !!mediaPath,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<string> => {
      const { data, error } = await supabase.storage
        .from('chat-media')
        .createSignedUrl(mediaPath as string, 3600);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}

/** Real end-to-end encrypted media (session 37/38 follow-up to docs/21) —
 * decrypts an e2ee thread's photo ciphertext (already downloaded from its
 * own signed URL, via useChatMediaUrl) into a `data:` URI React Native's
 * <Image> can render directly. Only enabled once both the signed URL and
 * the envelope-carried key/nonce (Message.e2eeMediaKeyBase64/
 * e2eeMediaNonceBase64, resolved by useThreadMessages' own decrypt path)
 * are available — a non-e2ee thread's photo never calls this, since
 * useChatMediaUrl's own result is already directly renderable for it.
 * `image/jpeg` matches uploadChatMedia's own fixed content-type for every
 * chat photo this app has ever accepted (docs/16 §2's JPEG-over-WebP
 * choice) — the encrypted bytes carry no format info of their own to read
 * instead. */
export function useDecryptedChatImageUri(
  mediaUrl: string | undefined,
  mediaKeyBase64: string | undefined,
  mediaNonceBase64: string | undefined,
) {
  return useQuery({
    queryKey: ['decryptedChatImage', mediaUrl, mediaKeyBase64],
    enabled: !!mediaUrl && !!mediaKeyBase64 && !!mediaNonceBase64,
    staleTime: 60 * 60 * 1000,
    queryFn: async (): Promise<string> => {
      const response = await fetch(mediaUrl as string);
      const ciphertext = new Uint8Array(await response.arrayBuffer());
      const plaintext = decryptMediaBytes(nativeSodiumProvider, ciphertext, {
        keyBase64: mediaKeyBase64 as string,
        nonceBase64: mediaNonceBase64 as string,
      });
      return `data:image/jpeg;base64,${bytesToBase64(plaintext)}`;
    },
  });
}

interface EditMessageRequest {
  threadId: string;
  messageId: string;
  body: string;
  /** Real end-to-end encryption (docs/21-E2EE-TECHNICAL-DESIGN.md §3) —
   * same reasoning as SendMessageRequest's own fields: pass the thread's
   * current e2ee_status and (whenever it's 'active') the other
   * participant's user id, so this mutation can re-encrypt `body` into a
   * fresh per-device envelope instead of sending it as plaintext.
   * fn_edit_message's envelope-replacement path (step 4) requires this —
   * Double Ratchet has no "edit in place", an edit is a brand-new
   * encrypt of the new text, checked server-side against the frozen
   * credits_charged exactly like a plaintext edit is. */
  e2eeStatus?: 'off' | 'active';
  partnerId?: string;
}

interface EditMessageResponse {
  message_id: string;
  word_count: number;
  credits_charged: number;
  edited_at: string;
}

/** Wraps POST /functions/v1/edit-message — never re-bills (CLAUDE.md rule
 * #1 + docs/03-ECONOMY-LEDGER.md's own "editing never re-bills" design):
 * `fn_edit_message` enforces sender-only, still-`escrowed`-only, within
 * the edit window, and no-cost-increase entirely server-side. This
 * mutation only forwards the request and invalidates the thread's
 * messages on success — `threadId` is only needed for that invalidation
 * (the request body itself never carries a thread id, since
 * `fn_edit_message` derives everything it needs from `message_id`). */
export function useEditMessage() {
  const queryClient = useQueryClient();

  return useMutation<EditMessageResponse, EdgeFunctionError, EditMessageRequest>({
    mutationFn: async (request: EditMessageRequest) => {
      let envelopes: ReturnType<typeof envelopesForRpc> | undefined;
      if (request.e2eeStatus === 'active') {
        if (!request.partnerId) {
          throw new Error('useEditMessage: an active-e2ee edit needs partnerId.');
        }
        const outgoing = await encryptForThread(request.threadId, request.partnerId, request.body);
        envelopes = envelopesForRpc(outgoing);
      }

      return callEdgeFunction<EditMessageResponse>('edit-message', {
        message_id: request.messageId,
        body: envelopes ? undefined : request.body,
        envelopes,
      });
    },
    onSuccess: async (data, variables) => {
      if (variables.e2eeStatus === 'active') {
        // Same reasoning as useSendMessage's own onSuccess: the sender's
        // edited copy has no envelope addressed to itself to decrypt
        // later, so the local plaintext cache is the only thing that
        // makes this device's own bubble show the new text rather than
        // "🔒 Message unavailable" going forward.
        await setCachedPlaintext(data.message_id, variables.body);
      }
      queryClient.invalidateQueries({ queryKey: ['messages', variables.threadId] });
    },
  });
}

interface DeleteMessageRequest {
  threadId: string;
  messageId: string;
}

/** Wraps POST /functions/v1/delete-message-for-me — a per-viewer
 * visibility hide (punch-list item 5, 2026-09-19), never touches the
 * message row itself, available on any message regardless of status/age.
 * Only invalidates this thread's own message list — nothing about this is
 * visible to the other participant, so there's nothing for them to
 * refetch. */
export function useDeleteMessageForMe() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, DeleteMessageRequest>({
    mutationFn: (request) =>
      callEdgeFunction('delete-message-for-me', { message_id: request.messageId }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.threadId] });
    },
  });
}

/** Wraps POST /functions/v1/delete-message-for-everyone — sender-only,
 * within the delete window; `fn_delete_message_for_everyone` enforces
 * both entirely server-side. The other participant picks this up via the
 * same Realtime `messages` subscription `useThreadMessages` already has
 * (an `UPDATE` on the row), so this mutation only needs to invalidate the
 * caller's own cache. */
export function useDeleteMessageForEveryone() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, DeleteMessageRequest>({
    mutationFn: (request) =>
      callEdgeFunction('delete-message-for-everyone', { message_id: request.messageId }),
    onSuccess: async (_data, variables) => {
      // A locally-cached plaintext copy of a message the sender just
      // deleted "for everyone" would defeat the point of that feature —
      // scrub it here too, not just server-side (which itself now also
      // scrubs the e2ee_message_envelopes ciphertext row,
      // 20260926180000_e2ee_delete_scrub_envelopes.sql — a recipient who
      // never opened the app between send and delete no longer has
      // anything left to decrypt afterward, closing the gap this comment
      // used to flag).
      await deleteCachedPlaintext(variables.messageId);
      queryClient.invalidateQueries({ queryKey: ['messages', variables.threadId] });
    },
  });
}

/** Wraps POST /functions/v1/mark-audio-played — called once, the first
 * time the RECIPIENT's client actually starts playing a voice note
 * (docs/17-VOICE-NOTES-SCOPING.md §8; playbackStore.toggle is the actual
 * call site). Patches this thread's already-loaded message list directly
 * rather than invalidating+refetching: the only thing that changed is one
 * timestamp on one row this device already has in memory, and the other
 * participant's own view of it updates via the same Realtime `messages`
 * subscription every other in-place edit here already relies on. Silently
 * swallows `cannot_mark_own_message_played` (the sender's own device
 * calling this on its own sent note, e.g. if `toggle` fires client-side
 * before `isOwn` is checked somewhere) — not a real failure, matching
 * this mutation's own "best-effort read-state signal" nature. */
export function useMarkAudioPlayed() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, DeleteMessageRequest>({
    mutationFn: (request) =>
      callEdgeFunction('mark-audio-played', { message_id: request.messageId }),
    onSuccess: (_data, variables) => {
      // setQueriesData (not setQueryData) — the real cache key is now
      // ['messages', threadId, e2eeStatus] (useThreadMessages's own
      // e2eeStatus-keying fix, session 37), and setQueryData only ever
      // matches an EXACT key, unlike invalidateQueries' default prefix
      // matching. A plain setQueryData(['messages', threadId], ...) here
      // would silently patch a cache entry that doesn't exist, a no-op
      // that never reaches the real displayed data.
      queryClient.setQueriesData<Message[]>({ queryKey: ['messages', variables.threadId] }, (old) =>
        old?.map((m) =>
          m.id === variables.messageId ? { ...m, audio_played_at: new Date().toISOString() } : m,
        ),
      );
    },
    onError: (error) => {
      if (error.code !== 'cannot_mark_own_message_played') {
        console.error('useMarkAudioPlayed failed:', error.message);
      }
    },
  });
}
