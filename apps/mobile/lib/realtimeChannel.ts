import type { RealtimeChannel } from '@supabase/supabase-js';
import { useEffect, useRef } from 'react';

import { supabase } from '@/lib/supabase';

/**
 * The fields every existing call site actually reads off a change payload
 * (confirmed by checking each one, not assumed) — a deliberately narrower
 * shape than supabase-js's own `RealtimePostgresChangesPayload`, since this
 * hook no longer gets real `postgres_changes` payloads (see below) and has
 * no reason to fabricate the extra fields (`schema`, `table`,
 * `commit_timestamp`, `errors`) that type carries and nothing here reads.
 */
interface ChangePayload {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}

type ChangeHandler = (payload: ChangePayload) => void;

interface BroadcastConfig {
  event: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  filter?: string;
}

interface RegistryEntry {
  channel: RealtimeChannel;
  refCount: number;
  listeners: Set<ChangeHandler>;
}

/**
 * Module-level, refcounted registry of live `RealtimeChannel`s, keyed by
 * topic string — shared across every component in the app, not per-hook-
 * instance state.
 *
 * Why this exists (found live, 2026-09-19, via a real reproduced crash —
 * see docs/00-SESSION-HANDOFF.md): every one of this app's Realtime
 * subscriptions used to create-and-subscribe its own `supabase.channel(topic)`
 * directly in a `useEffect`, tearing it down with `removeChannel` on
 * unmount. That's unsafe for two reasons this app actually hits, not
 * hypothetically:
 *
 * 1. **Two components legitimately subscribing to the same topic at the
 *    same time.** React Navigation keeps tab screens mounted once visited
 *    (the Wallet tab doesn't unmount just because you navigated to a
 *    thread pushed on top of it) — `useWallets(userId)` is called from
 *    both `wallet.tsx` and `thread/[id].tsx`, so both mount concurrently
 *    and both tried to subscribe to the exact same `wallets:${userId}`
 *    topic. supabase-js throws ("cannot add `postgres_changes` callbacks
 *    ... after `subscribe()`") the moment the second one calls `.on()` on
 *    what the client considers an already-subscribed topic — an immediate,
 *    reproducible crash on opening any thread once the Wallet tab has ever
 *    been visited.
 * 2. **A fast remount of the same topic** (navigate away from a thread and
 *    back into the *same* thread) can race the outgoing mount's cleanup
 *    against the incoming mount's setup, hitting the identical error.
 *
 * The fix is a shared subscription, not a defensive per-site retry: every
 * `useRealtimeTableChanges` caller for a given topic shares one real
 * channel and one real `.on()` registration; the channel is only actually
 * torn down once the last caller unmounts. Correct by construction — there
 * is no window where two `.on()` calls can race a `.subscribe()` on the
 * same channel, and no unrelated consumer of the same topic gets its
 * subscription killed by another consumer's unmount.
 */
const registry = new Map<string, RegistryEntry>();

/**
 * Subscribes to Supabase Realtime **Broadcast** on a shared, private
 * channel for `topic`, fanning out to every hook instance currently
 * interested in it.
 *
 * This used to subscribe to `postgres_changes` directly — migrated
 * 2026-10-08 (docs/01-ARCHITECTURE.md §4) because `postgres_changes`
 * authorizes every single row change against every active subscriber
 * individually (Supabase's own documented scaling ceiling: throughput
 * degrades with subscriber count, not write rate, and changes are
 * processed on one thread to preserve ordering). Every table this hook
 * ever subscribes to (`messages`, `group_messages`, `wallets`, `topups`,
 * `threads`, `users`) now has a trigger (see
 * `supabase/migrations/20261008120000_realtime_broadcast_migration.sql`)
 * that calls `realtime.broadcast_changes()` to push to this exact topic
 * string instead, authorized via RLS on `realtime.messages` rather than
 * the underlying table's own RLS — each policy was written to be the
 * precise equivalent of that table's existing SELECT policy, verified
 * directly against the live policies, not assumed.
 *
 * `{ config: { private: true } }` is required for a channel whose access
 * is gated by Realtime Authorization (RLS) rather than left open — see the
 * migration's own header for why this project's topic strings are already
 * exactly the authorization boundary (one user, one thread, one group, or
 * one topup per topic).
 *
 * The broadcast payload's shape (`{ type, event, payload: { operation,
 * record, old_record, table, schema } }`) is translated back into the same
 * `{ eventType, new, old }` shape `postgres_changes` always delivered, so
 * every existing caller (`messages.ts`, `threads.ts`, `groups.ts`,
 * `wallet.ts`, `thread/[id].tsx`) needed zero changes.
 *
 * `config` is assumed identical across every caller for a given `topic` in
 * this app (true in practice — the topic string itself already encodes the
 * specific row/user/thread/group/topup being watched, so nothing here
 * needs to reconcile differing filters for the same topic). `config.event`
 * still drives which broadcast event(s) this subscribes to — `'*'` is a
 * genuinely supported wildcard for broadcast too (confirmed directly
 * against `realtime-js`'s own dispatch logic, not just its docs' examples,
 * which only ever show per-event-name `.on()` calls). `config.schema`/
 * `.table`/`.filter` are no longer meaningful (the topic alone fully scopes
 * a broadcast subscription; there is no equivalent of a postgres_changes
 * row filter) but are kept in the call-site signature rather than touching
 * every caller just to drop now-unused fields.
 *
 * `onChange` is read via a ref, not a `useEffect` dependency — every
 * existing call site passes a fresh inline closure each render (e.g.
 * `() => queryClient.invalidateQueries(...)`), and depending on it
 * directly would tear down and recreate the shared channel on every
 * single render of every subscriber, defeating the whole point of
 * sharing it. Callers always get the latest closure without needing to
 * `useCallback`-wrap anything themselves.
 */
export function useRealtimeTableChanges(
  topic: string | undefined,
  config: BroadcastConfig,
  onChange: ChangeHandler,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!topic) return;

    const listener: ChangeHandler = (payload) => onChangeRef.current(payload);

    let entry = registry.get(topic);
    if (!entry) {
      const channel = supabase.channel(topic, { config: { private: true } });
      const newEntry: RegistryEntry = { channel, refCount: 0, listeners: new Set() };
      registry.set(topic, newEntry);
      channel
        .on(
          'broadcast',
          { event: config.event },
          (raw: {
            payload: {
              operation: 'INSERT' | 'UPDATE' | 'DELETE';
              record: Record<string, unknown> | null;
              old_record: Record<string, unknown> | null;
            };
          }) => {
            const payload: ChangePayload = {
              eventType: raw.payload.operation,
              new: raw.payload.record ?? {},
              old: raw.payload.old_record ?? {},
            };
            for (const l of newEntry.listeners) l(payload);
          },
        )
        .subscribe();
      entry = newEntry;
    }

    entry.refCount += 1;
    entry.listeners.add(listener);

    return () => {
      const current = registry.get(topic);
      if (!current) return;
      current.listeners.delete(listener);
      current.refCount -= 1;
      if (current.refCount <= 0) {
        registry.delete(topic);
        supabase.removeChannel(current.channel);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);
}
