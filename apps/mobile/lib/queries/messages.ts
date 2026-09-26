import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction, EdgeFunctionError } from '@/lib/edgeFunctions';
import { deleteCachedPlaintext, setCachedPlaintext } from '@/lib/e2ee/plaintextCache';
import { decryptThreadMessages, encryptForThread, type OutgoingEnvelope } from '@/lib/e2ee/session';
import { useRealtimeTableChanges } from '@/lib/realtimeChannel';
import { supabase } from '@/lib/supabase';

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
  body: string;
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
  /** Always `'image'` today — the column exists ahead of a future video
   * follow-up (docs/16 §4), not a sign one is imminent. */
  media_type: string | null;
  /** docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1 — the status this
   * message replied to, if any. Only ever drives display (a "replied to
   * your status" preview); whether the send was actually free is read off
   * `credits_charged`/`status` above, never inferred from this being set. */
  reply_to_status_id: string | null;
}

/** Messages in a thread, oldest first, kept live via Realtime — per
 * docs/05-API-REALTIME-SPEC.md §3 (`postgres_changes` on `messages`
 * filtered by `thread_id`). Presence/typing-indicator/read-receipt
 * channels from that same section aren't implemented here — flagged as a
 * deliberate v1 gap, not an oversight.
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
  const queryKey = ['messages', threadId];

  const query = useQuery({
    queryKey,
    enabled: !!threadId && !!currentUserId,
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from('messages')
        .select(
          'id, thread_id, sender_id, body, word_count, credits_charged, status, created_at, edited_at, deleted_for_everyone, read_at, reply_to_message_id, is_forwarded, media_path, media_type, reply_to_status_id',
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
      // every row here has body: null from the server; decryptThreadMessages
      // resolves as many as it can (from the durable local plaintext cache,
      // or by consuming this device's own envelope + ratchet state — see
      // that function's own header comment for why a cache miss on the
      // sender's own message is unrecoverable by construction, not a bug).
      const decrypted = await decryptThreadMessages(
        threadId as string,
        currentUserId as string,
        visible,
      );
      return visible.map((m) => ({
        ...m,
        body: decrypted.get(m.id) ?? '🔒 Message unavailable',
      }));
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
            const resolvedRow = { ...row, body: decrypted.get(row.id) ?? '🔒 Message unavailable' };
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
        const outgoing = await encryptForThread(request.threadId, request.partnerId, request.body);
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
        await setCachedPlaintext(data.message_id, variables.body);
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
 * (lib/queries/status.ts). */
export function useCreateChatMediaUploadUrl() {
  return useMutation({
    mutationFn: () =>
      callEdgeFunction<CreateChatMediaUploadUrlResponse>('create-chat-media-upload-url'),
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
