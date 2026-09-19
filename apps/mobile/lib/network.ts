import NetInfo from '@react-native-community/netinfo';
import { useSyncExternalStore } from 'react';

/**
 * Single source of truth for "is this device online right now" — a module-
 * level value kept in sync by one NetInfo listener, not a listener per
 * hook instance. `useIsOnline()` and `callEdgeFunction`'s pre-flight check
 * (lib/edgeFunctions.ts) both read this same value, so a screen's banner
 * and a mutation's gating can never disagree about connectivity state.
 *
 * `isConnected && isInternetReachable !== false` — NetInfo's own
 * `isInternetReachable` is `null` until its first active reachability probe
 * resolves, which this treats as "assume online" (matching `isConnected`
 * alone) rather than flashing an incorrect offline banner on cold start
 * before the probe has had a chance to run.
 */
let isOnline = true;
const listeners = new Set<() => void>();

NetInfo.addEventListener((state) => {
  const next = !!state.isConnected && state.isInternetReachable !== false;
  if (next === isOnline) return;
  isOnline = next;
  for (const l of listeners) l();
});

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

function getSnapshot() {
  return isOnline;
}

/** Live connectivity state — re-renders the caller on every change. */
export function useIsOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Non-reactive read for call sites that aren't React components (e.g.
 * `callEdgeFunction`'s pre-flight check). */
export function getIsOnline(): boolean {
  return isOnline;
}
