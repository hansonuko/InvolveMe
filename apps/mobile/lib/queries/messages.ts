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
}

/** Messages in a thread, oldest first, kept live via Realtime — per
 * docs/05-API-REALTIME-SPEC.md §3 (`postgres_changes` on `messages`
 * filtered by `thread_id`). Presence/typing-indicator/read-receipt
 * channels from that same section aren't implemented here — flagged as a
 * deliberate v1 gap, not an oversight. */
export function useThreadMessages(threadId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['messages', threadId];

  const query = useQuery({
    queryKey,
    enabled: !!threadId,
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from('messages')
        .select('id, thread_id, sender_id, body, word_count, credits_charged, status, created_at')
        .eq('thread_id', threadId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data ?? [];
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
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['messages', data.thread_id] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });
}
