import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { useEffect, useRef } from 'react';

import { supabase } from '@/lib/supabase';

type ChangeHandler = (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void;

interface PostgresChangesConfig {
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
 * Subscribes to `postgres_changes` on a shared channel for `topic`,
 * fanning out to every hook instance currently interested in it. `config`
 * is assumed identical across every caller for a given `topic` in this
 * app (true in practice — the topic string itself already encodes the
 * specific row/user/thread being watched, so nothing here needs to
 * reconcile differing filters for the same topic).
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
  config: PostgresChangesConfig,
  onChange: ChangeHandler,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!topic) return;

    const listener: ChangeHandler = (payload) => onChangeRef.current(payload);

    let entry = registry.get(topic);
    if (!entry) {
      const channel = supabase.channel(topic);
      const newEntry: RegistryEntry = { channel, refCount: 0, listeners: new Set() };
      registry.set(topic, newEntry);
      channel
        .on('postgres_changes', config, (payload) => {
          for (const l of newEntry.listeners) l(payload);
        })
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
