/**
 * Single source of truth for "is this device online right now" — read by
 * the offline banner, the outbox drain, `callEdgeFunction`'s pre-flight
 * gate, and both thread screens' send handlers.
 *
 * STUBBED as always-online (2026-09-19): real detection needs
 * `@react-native-community/netinfo`, a *native* module the already-shipped
 * build doesn't have compiled in — wiring it in only takes effect after a
 * fresh `eas build`, which the user explicitly chose to defer rather than
 * spend build quota on right now (docs/13-OFFLINE-MODE-SCOPING.md §5) —
 * matching this app's own standing "never build without explicit ask"
 * rule and the same deferred-native-dependency pattern already used for
 * calls/linked-devices (docs/11, docs/12).
 *
 * Every offline-mode feature that reads this (the banner, the outbox
 * enqueue branch in thread/[id].tsx and group-thread/[id].tsx, the gate in
 * lib/edgeFunctions.ts) degrades to exactly its pre-offline-mode behavior
 * while this always returns `true` — nothing crashes, nothing changes for
 * users on the current build; the persisted query cache and the
 * client_message_id idempotency fix (migration 20260919150000) still ship
 * and still help regardless of this stub.
 *
 * To activate real detection once a native build is authorized: run
 * `npx expo install @react-native-community/netinfo` in apps/mobile, then
 * replace this file's body with a NetInfo-backed `useSyncExternalStore`
 * listener (see this file's git history on the `feat/offline-mode` branch,
 * commit 13c2585, for the exact previous implementation) — no other file
 * needs to change, since `useIsOnline()`/`getIsOnline()`'s signatures are
 * unchanged.
 */
export function useIsOnline(): boolean {
  return true;
}

export function getIsOnline(): boolean {
  return true;
}
