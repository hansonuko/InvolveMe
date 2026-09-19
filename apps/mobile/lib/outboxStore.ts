import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** A message composed while offline, queued for the outbox drain to send
 * the moment connectivity returns (docs/13-OFFLINE-MODE-SCOPING.md).
 * `clientMessageId` is the idempotency key `fn_send_message`/
 * `fn_send_group_message_free` now accept — generated once here, at
 * compose time, and carried through every retry so a dropped-connection
 * retry can never double-send. `senderId` guards against draining a
 * different, now-signed-out user's leftover queued items under the
 * currently signed-in session after an account switch on the same device. */
export interface OutboxItem {
  clientMessageId: string;
  body: string;
  createdAt: string;
  senderId: string;
  target:
    | { kind: '1:1'; threadId?: string; recipientId?: string }
    | { kind: 'group'; groupThreadId: string };
  /** WhatsApp-style reply/forward metadata, carried through a queued send
   * exactly like an online one — see thread/[id].tsx's `sendOrQueue`
   * helper, the single place that decides online-vs-queued for both a
   * normal send and a forward. `replyToMessageId` only applies to `1:1`
   * targets in this pass (see docs comment on the mobile reply UI). */
  replyToMessageId?: string;
  isForwarded?: boolean;
}

interface OutboxState {
  items: OutboxItem[];
  enqueue: (item: OutboxItem) => void;
  remove: (clientMessageId: string) => void;
}

/** UI-local state, not server data (CLAUDE.md's Zustand-vs-TanStack-Query
 * split) — persisted via Zustand's own `persist` middleware (already a
 * transitive part of the `zustand` dependency already in this app, no new
 * package) onto the AsyncStorage this app already depends on, so a queued
 * message survives an app kill while still offline, same as WhatsApp. */
export const useOutboxStore = create<OutboxState>()(
  persist(
    (set) => ({
      items: [],
      enqueue: (item) => set((s) => ({ items: [...s.items, item] })),
      remove: (clientMessageId) =>
        set((s) => ({ items: s.items.filter((i) => i.clientMessageId !== clientMessageId) })),
    }),
    {
      name: 'outbox-v1',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
