import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction, EdgeFunctionError } from '@/lib/edgeFunctions';
import { useRealtimeTableChanges } from '@/lib/realtimeChannel';
import { supabase } from '@/lib/supabase';

export interface Message {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string;
  word_count: number;
  credits_charged: number;
  status: 'escrowed' | 'released' | 'refunded';
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
  /** The quoted message's id, for a WhatsApp-style reply preview —
   * resolved against this same thread's already-loaded `messages` array
   * client-side (no extra query), since every message in a thread is
   * already in memory once the thread screen has loaded. `null` for an
   * ordinary (non-reply) message. */
  reply_to_message_id: string | null;
  /** Renders a small "Forwarded" tag — display-only, never a pricing
   * signal (see migration 20260920090000's header comment). */
  is_forwarded: boolean;
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
export function useThreadMessages(threadId: string | undefined, currentUserId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['messages', threadId];

  const query = useQuery({
    queryKey,
    enabled: !!threadId && !!currentUserId,
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from('messages')
        .select(
          'id, thread_id, sender_id, body, word_count, credits_charged, status, created_at, edited_at, deleted_for_everyone, reply_to_message_id, is_forwarded',
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
      return data.filter((m) => !deletedIds.has(m.id));
    },
  });

  useRealtimeTableChanges(
    threadId ? `messages:${threadId}` : undefined,
    { event: '*', schema: 'public', table: 'messages', filter: `thread_id=eq.${threadId}` },
    () => {
      // Re-fetch rather than patch the cache from the payload directly —
      // an UPDATE (e.g. escrow release flipping status) only carries the
      // changed row, and refetching keeps this trivially correct at the
      // cost of one extra read per event, acceptable at this app's scale.
      queryClient.invalidateQueries({ queryKey });
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

/** "Shared links" for a thread's contact-info screen — the honest
 * WhatsApp-parity equivalent of its shared-media grid. This app's chat
 * messages are text-only with no photo/video attachment pipeline at all
 * (docs/03-ECONOMY-LEDGER.md: "chat media has no pipeline of any kind
 * yet"), so a faked media grid would have nothing real behind it; links
 * mentioned in message text are real, already-stored data this can surface
 * without inventing anything. A one-shot fetch, not kept live via
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
    mutationFn: (request: SendMessageRequest) =>
      callEdgeFunction<SendMessageResponse>('send-message', {
        thread_id: request.threadId,
        recipient_id: request.recipientId,
        body: request.body,
        client_message_id: request.clientMessageId,
        reply_to_message_id: request.replyToMessageId,
        is_forwarded: request.isForwarded,
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['messages', data.thread_id] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });
}

interface EditMessageRequest {
  threadId: string;
  messageId: string;
  body: string;
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
    mutationFn: (request: EditMessageRequest) =>
      callEdgeFunction<EditMessageResponse>('edit-message', {
        message_id: request.messageId,
        body: request.body,
      }),
    onSuccess: (_data, variables) => {
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
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['messages', variables.threadId] });
    },
  });
}
