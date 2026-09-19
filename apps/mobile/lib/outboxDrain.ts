import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { EdgeFunctionError, callEdgeFunction } from '@/lib/edgeFunctions';
import { useIsOnline } from '@/lib/network';
import { useOutboxStore } from '@/lib/outboxStore';

interface SendMessageResponse {
  thread_id: string;
}

/** Flushes the offline outbox (docs/13-OFFLINE-MODE-SCOPING.md) the moment
 * connectivity returns, in FIFO order, one at a time — mounted once,
 * globally, in app/_layout.tsx (not per-thread-screen), so a message
 * queued while a thread was open still sends even if the user has since
 * navigated away or the app was backgrounded and relaunched.
 *
 * Calls the exact same Edge Functions `useSendMessage`/`useSendGroupMessage`
 * call, with the same `client_message_id` the item was queued under, so a
 * retry-after-a-still-dropped-connection mid-drain can never double-send
 * (see the `fn_send_message`/`fn_send_group_message_free` idempotency fix,
 * migration 20260919150000). Invalidates the same query keys those hooks'
 * own `onSuccess` would, so a currently-open thread/group screen or the
 * wallet tab picks up the result without needing its own reconciliation
 * logic for "a message I queued somewhere else just landed."
 */
export function useOutboxDrain(currentUserId: string | undefined) {
  const isOnline = useIsOnline();
  const queryClient = useQueryClient();
  const draining = useRef(false);

  useEffect(() => {
    if (!isOnline || !currentUserId || draining.current) return;

    async function drain() {
      draining.current = true;
      try {
        for (;;) {
          // Re-read the store on every iteration rather than snapshotting
          // once — composing another message mid-drain appends to it live.
          const next = useOutboxStore.getState().items.find((i) => i.senderId === currentUserId);
          if (!next) break;

          try {
            if (next.target.kind === '1:1') {
              const res = await callEdgeFunction<SendMessageResponse>('send-message', {
                thread_id: next.target.threadId,
                recipient_id: next.target.recipientId,
                body: next.body,
                client_message_id: next.clientMessageId,
                reply_to_message_id: next.replyToMessageId,
                is_forwarded: next.isForwarded,
              });
              queryClient.invalidateQueries({ queryKey: ['messages', res.thread_id] });
              queryClient.invalidateQueries({ queryKey: ['threads'] });
              queryClient.invalidateQueries({ queryKey: ['wallets'] });
            } else {
              await callEdgeFunction('send-group-message', {
                group_thread_id: next.target.groupThreadId,
                body: next.body,
                client_message_id: next.clientMessageId,
                is_forwarded: next.isForwarded,
              });
              queryClient.invalidateQueries({
                queryKey: ['groupMessages', next.target.groupThreadId],
              });
              queryClient.invalidateQueries({ queryKey: ['groups'] });
            }
            useOutboxStore.getState().remove(next.clientMessageId);
          } catch (e) {
            if (e instanceof EdgeFunctionError && e.code === 'offline') {
              // Connectivity flapped again mid-drain — leave this item
              // queued and stop; the effect re-fires next time isOnline
              // flips true.
              break;
            }
            // A genuine rejection (content_blocked, thread_blocked,
            // insufficient_credit, wallet_frozen, message_too_long, ...)
            // can never succeed by blindly retrying forever — drop it and
            // move on to whatever's queued behind it rather than spin on
            // one bad item and silently block every message after it.
            console.error('outbox drain: send failed, dropping item', next.clientMessageId, e);
            useOutboxStore.getState().remove(next.clientMessageId);
          }
        }
      } finally {
        draining.current = false;
      }
    }

    void drain();
  }, [isOnline, currentUserId, queryClient]);
}
