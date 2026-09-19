# 13 — Offline Mode: Scoping + Build Notes

**Status: built this session (punch-list item 8, 2026-09-19), live connectivity detection deferred pending a native build.** This doc is written as the refined scope _and_ the record of what shipped — the verbal scope from the session that closed out items 1-7 was never committed to a file, so this is that refinement done properly, plus the real gap it surfaced.

**§5 — the native-build deferral.** `@react-native-community/netinfo` (real connectivity detection) is a _native_ module — the already-shipped build doesn't have it compiled in, and OTA can only ship JS/assets, never new native linkage. Per the user's explicit choice, this was **not** turned into an unplanned `eas build` — the standing "never build without explicit ask" rule applies here exactly as it does to any other native-dependency addition (same posture as the calls/linked-devices scoping docs, `docs/11`/`docs/12`). `lib/network.ts` currently ships as an always-online stub (see that file's own header comment for the one-file swap needed once a build is authorized) so everything built this session — the persisted query cache, the outbox plumbing, the `callEdgeFunction` offline gate, both thread screens' enqueue branches — degrades to exactly its pre-offline-mode behavior rather than crashing or half-working. The `client_message_id` idempotency fix (migration `20260919150000`) has no client dependency at all and stays fully live regardless.

**The ask, restated precisely:** the app opens and works fully offline — every screen browsable, every cached bit of data visible — except two categories that genuinely require a live connection: (1) sending/replying to messages (1:1 and group), and (2) wallet/financial actions and anything that needs a fresh server read to be safe (top-up, withdraw, credit transfer, KYC/bank-linking, group admin mutations, status posting). WhatsApp is the explicit reference point: it never blocks you from opening the app or scrolling history offline, it queues composed messages with a clock icon and sends them the moment connectivity returns, and it shows a thin "Connecting..." / "No internet connection" banner rather than a modal or a blank screen.

## 1. Baseline audited before designing anything (ground truth, not assumption)

- **No offline infrastructure exists in this codebase today.** No `NetInfo`/`expo-network` connectivity listener anywhere, no `expo-sqlite`, no query-cache persister, no outbox/queue of any kind. `docs/01-ARCHITECTURE.md`'s mention of a SQLite outbox was _planned intent_, never built — confirmed by grepping the entire mobile app for `outbox`, `NetInfo`, `persistQueryClient`, `expo-sqlite`: zero matches.
- `apps/mobile/app/_layout.tsx` creates a plain in-memory `QueryClient()` with no persister — every cached read is gone on app restart or cold background-kill, offline or not.
- `@react-native-async-storage/async-storage` is already a dependency (used today only for a few settings flags) — enough to build a query-cache persister on without adding a new storage engine.
- Every money-affecting call goes through exactly one choke point, `lib/edgeFunctions.ts`'s `callEdgeFunction()` (CLAUDE.md rule #1) — the single place offline-gating needs to hook in for financial actions.
- Every Realtime subscription goes through exactly one choke point, `lib/realtimeChannel.ts`'s shared-channel registry — the single place reconnect/resubscribe logic needs to hook in.
- **The real gap this audit found, not previously scoped anywhere:** `send-message` (`fn_send_message`) and `send-group-message` (`fn_send_group_message_free`) have **zero idempotency support**. An offline outbox that retries a queued send after a flaky reconnect — the exact scenario this feature exists to handle — would, without a fix, double-debit the payer and insert a duplicate message on any retry where the server actually processed the first attempt but the client never saw the response. This is a ledger-correctness bug waiting to happen (CLAUDE.md rules #3/#4), not a nice-to-have, so closing it is part of this feature, not a follow-up.

## 2. What "works offline" means, concretely

**Fully usable offline (cached, last-known data, clearly marked when stale):**

- Chat list, thread history (already-fetched messages), groups list, group threads, status feed (already-fetched), profiles, settings, wallet balance/transaction history _as last known_ — every read-only screen the app has.
- Composing a message in a 1:1 or group thread — it queues to the outbox and renders as a pending "clock" bubble, same as WhatsApp, rather than being blocked.

**Blocked while offline, with a clear reason shown, never a silent failure or a hung spinner:**

- Actually delivering a queued message to the server (queued locally, sent automatically the moment connectivity returns).
- Top-up, withdraw, credit transfer, KYC/bank-account actions, group admin mutations (add/remove/promote/edit), status posting, profile edits that hit the server — anything through `callEdgeFunction` or a server-mutating Supabase call. These fail fast with an explicit "You're offline — try again once you're connected" message instead of hanging on a dead fetch or surfacing a generic network-error toast.

## 3. Design

**Connectivity detection:** `@react-native-community/netinfo` (the standard, Expo-compatible RN library for this — not reinventing it with polling) behind a single `useIsOnline()` hook in a new `lib/network.ts`, backed by a tiny module-level store so both the global banner and the pre-flight check in `callEdgeFunction` read the same live value without prop-drilling.

**Financial/mutation gating:** `callEdgeFunction()` gets one new check at the top — if offline, throw the same `EdgeFunctionError` shape with a new `offline` code before ever attempting `fetch`, so every existing caller's error handling (already built for `EdgeFunctionError`) picks it up for free with no per-screen changes. This is the "hold and notify, never half-attempt" posture CLAUDE.md rule #7 already establishes for withdrawals, applied to the general case.

**Read-side caching:** replace the plain `QueryClient` in `_layout.tsx` with TanStack's own official `PersistQueryClientProvider` (`@tanstack/react-query-persist-client` + `@tanstack/query-async-storage-persister`) writing to the existing AsyncStorage dependency — no new storage engine, matches CLAUDE.md rule #10's "lite" mandate. A 24-hour `maxAge` and a bumped `buster` string on any breaking query-shape change (documented inline) keep this from ever serving indefinitely-stale or shape-mismatched data.

**Outbox (send-side):** a persisted Zustand slice (`store/outboxStore.ts`, AsyncStorage-backed via `zustand/middleware`'s `persist` — same library already used everywhere else for local state, no new dependency), keyed by a client-generated `client_message_id` (uuid) per composed message. Composing while offline appends to the outbox and renders immediately as a pending bubble; a single drain effect (mounted once, near the network hook) flushes the outbox in FIFO order the moment `useIsOnline()` flips true, calling the _exact same_ `useSendMessage`/`useSendGroupMessage` mutations already in use — now passing `client_message_id` through — so there is exactly one send code path for both the online and the queued-then-flushed case, not two parallel implementations to keep in sync.

**The idempotency fix (the real gap from §1):** `messages` and `group_messages` both get a nullable `client_message_id uuid` column plus a partial unique index on `(sender_id, client_message_id) where client_message_id is not null`. `fn_send_message` and `fn_send_group_message_free` both take a new optional `p_client_message_id` parameter (default `null`, so every existing caller — direct SQL in tests, other Edge Functions — is unaffected); if a message with that `(sender_id, client_message_id)` pair already exists, the function returns the original result instead of re-inserting/re-debiting. `fn_send_message`'s existing `select ... for update` lock on the `threads` row already serializes same-thread retries so this is correct-by-construction for true concurrent duplicates, not just sequential ones; `fn_send_group_message_free` has no equivalent lock, so its insert is wrapped in a `begin/exception when unique_violation` fallback to the same effect.

**Banner:** a single thin `OfflineBanner` mounted once in `_layout.tsx` above the navigator (matching `AppLockScreen`'s existing overlay pattern) — "No internet connection" while offline, briefly "Connecting..." on the transition back, then dismisses. No new UI pattern invented; reuses the theme tokens per `docs/04-DESIGN-SYSTEM.md`.

**Realtime resubscribe:** no explicit code needed — `lib/realtimeChannel.ts`'s shared registry already re-subscribes on every mount and supabase-js's own client already reconnects its socket automatically; the gap was only ever on the send/outbox side, not Realtime.

## 4. What this deliberately does not do (v1 scope cut)

- No offline _editing_ or _deleting_ of messages queued while still pending in the outbox beyond "remove before it sends" — matching WhatsApp's own behavior (you can't edit a message still showing the clock icon).
- No conflict resolution beyond FIFO ordering — this app has no scenario where two devices compose for the same user concurrently (no linked-devices/web client yet, see `docs/12`), so last-write-wins ordering is sufficient, not a gap.
- Group admin actions, status posting, and KYC/withdrawal flows are blocked outright while offline rather than queued — these are exactly the actions WhatsApp itself never queues either (compare: WhatsApp Business catalog edits, payments), and queuing a wallet-mutating action risks executing against stale state once reconnected (a balance/eligibility check that was true when composed may no longer hold).
