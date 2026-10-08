# 01 — Architecture

## 1. Stack decisions on record

| Layer                                                                | Choice                                                                                  | Why                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile client                                                        | React Native + Expo (managed, prebuild when a native module demands it), TypeScript     | Fastest path to iOS+Android from one codebase, OTA updates via EAS Update for non-native changes, mature payment/animation ecosystem.                                                                                                    |
| Realtime + DB + Auth + Storage                                       | Supabase (managed Postgres)                                                             | Chosen over a fully custom Node backend to move faster; the money-moving logic that would normally justify a custom backend is instead pushed **into Postgres itself** (see §3) rather than trusted to the client or to ad-hoc triggers. |
| Server-side business logic                                           | Supabase Edge Functions (Deno/TypeScript) calling `SECURITY DEFINER` Postgres functions | Every credit/wallet/payment mutation is a database transaction, invoked only through an Edge Function that authenticates the caller — never directly from the client via the anon key.                                                   |
| Payments (collections + payouts)                                     | Flutterwave now, Paystack provisioned behind an interface                               | Per product decision; see `docs/07-COMPLIANCE-LEGAL.md` for why a licensed PSP — not InvolveMe — must be the one actually touching bank rails.                                                                                           |
| Push notifications                                                   | Expo Notifications (FCM/APNs under the hood)                                            | Native Expo integration, no extra SDK.                                                                                                                                                                                                   |
| Media storage                                                        | Supabase Storage, aggressively compressed                                               | Keeps the app "lite" — see §5.                                                                                                                                                                                                           |
| Observability                                                        | Sentry (client + Edge Functions), Supabase's own log drains                             | Minimal footprint, one vendor for both sides.                                                                                                                                                                                            |
| Scheduled jobs (auto-withdrawal sweep, escrow expiry, KYC re-checks) | `pg_cron` inside Supabase + a dedicated Edge Function per job                           | No separate worker fleet needed at this scale.                                                                                                                                                                                           |

## 2. High-level system diagram

```
┌──────────────────────────┐
│   React Native (Expo)    │
│  ─────────────────────   │
│  UI, Zustand, TanStack Q  │
│  Reanimated/Moti motion   │
│  Supabase JS client       │
│  (auth + realtime only —  │
│   NO money math here)     │
└─────────────┬─────────────┘
              │ HTTPS (Edge Functions) + WSS (Realtime)
              ▼
┌───────────────────────────────────────────────────────────┐
│                      Supabase Project                      │
│                                                             │
│  ┌─────────────┐   ┌───────────────────────────────────┐  │
│  │   Auth      │   │        Edge Functions (Deno)        │  │
│  │  (phone OTP)│   │  send-message · buy-credit ·        │  │
│  └─────────────┘   │  withdraw · post-status · webhook-  │  │
│                     │  flutterwave · kyc-callback         │  │
│  ┌─────────────┐   └───────────────┬───────────────────┘  │
│  │  Realtime   │                   │ RPC (SECURITY DEFINER)│
│  │ (chat, sta- │                   ▼                       │
│  │  tus, wallet│   ┌───────────────────────────────────┐  │
│  │  balance    │   │             Postgres                │  │
│  │  pushes)    │   │  users · wallets · ledger_entries · │  │
│  └─────────────┘   │  messages · threads · escrows ·     │  │
│                     │  pricing_config · kyc_records ·     │  │
│  ┌─────────────┐   │  fraud_signals · withdrawals         │  │
│  │  Storage    │   │  (RLS on everything; ledger tables  │  │
│  │ (media,     │   │   are append-only, no client UPDATE/│  │
│  │  avatars)   │   │   DELETE grants at all)              │  │
│  └─────────────┘   └───────────────────────────────────┘  │
│                                                             │
│  ┌─────────────┐                                            │
│  │  pg_cron    │──▶ escrow-expiry-sweep, auto-withdraw-sweep│
│  └─────────────┘    kyc-recheck, dormant-fee (see §economy) │
└───────────────────────────────┬─────────────────────────────┘
                                 │ REST (server-to-server, signed)
                                 ▼
                    ┌─────────────────────────┐
                    │   Flutterwave (Collec-  │
                    │   tions API + Transfers │
                    │   API) · Paystack later │
                    └─────────────────────────┘
```

## 3. The core architectural decision: where does money logic live?

Supabase was chosen for speed, but a wallet/escrow/payout system is exactly the kind of thing that's dangerous to build on pure client-callable BaaS. The mitigation baked into this architecture:

- **The Postgres `anon` and `authenticated` roles have zero direct `UPDATE`/`DELETE` grants on `wallets`, `ledger_entries`, `escrows`, or `withdrawals`.** The only way to move a balance is through a `SECURITY DEFINER` SQL function (e.g. `fn_send_message`, `fn_buy_credit`, `fn_release_escrow`, `fn_withdraw`) that Edge Functions call via RPC after verifying the caller's JWT.
- Each of those functions runs as **one transaction** with explicit row locks on every wallet it touches (see `docs/02-DATA-MODEL.md` for the locking order that prevents deadlocks).
- Client reads balances via Realtime subscriptions on a `wallets` row it's allowed to `SELECT` (RLS: own row only) — it never computes a balance itself.
- This gets almost all the benefit of a custom backend for the parts that matter (financial correctness) while keeping Supabase's speed for everything else (auth, realtime fan-out, storage, admin dashboarding via the Supabase Studio).

If usage outgrows Postgres-function-as-backend (heavy custom fraud ML, complex payout orchestration, multi-currency), the plan is to peel those specific concerns into a small dedicated Node service that talks to the same Postgres instance — not a full rewrite. Keep Edge Functions thin enough that this extraction stays cheap.

## 4. Realtime chat design

- Chat uses **Supabase Realtime Broadcast** (migrated 2026-10-08 from `postgres_changes`/logical replication — see `supabase/migrations/20261008120000_realtime_broadcast_migration.sql`): a trigger on each realtime-relevant table (`messages`, `group_messages`, `wallets`, `topups`, `threads`, `users`) calls `realtime.broadcast_changes()` to push to a per-scope topic (`messages:<thread_id>`, `wallets:<user_id>`, `group-messages:<group_id>`, …), and access to each topic is gated by RLS on `realtime.messages` (Realtime Authorization) rather than the underlying table's own row-level RLS. Each of those policies is the deliberate equivalent of that table's existing SELECT policy — same "who can see what," just re-expressed against a topic string. The reason for the migration: `postgres_changes` re-authorizes every single row change against every active subscriber individually, so throughput degrades with subscriber count rather than write rate (Supabase's own documented scaling ceiling) — a real concern for a chat app expecting mobile _and_ web clients at meaningful concurrent scale. Client-side, every subscription still goes through the one shared hook in `apps/mobile/lib/realtimeChannel.ts`.
- Sending a message is **not** a direct table insert from the client. It's a call to the `send-message` Edge Function, which: validates the sender has enough balance for the computed word-tier cost → runs `fn_send_message` (debit + insert message row + escrow bookkeeping, all one transaction) → returns the persisted message. The client never inserts into `messages` directly (enforced by RLS: no client `INSERT` grant on `messages`).
- Typing indicators and read receipts are **ephemeral** Realtime Presence/Broadcast channels, not persisted rows — keeps the ledger tables free of non-financial noise and keeps the app lite.
- Message delivery ordering and offline queue: client keeps an outbox in local SQLite (via `expo-sqlite`) for messages composed while offline; on reconnect they replay through the same Edge Function one at a time (never batched, so each still gets correct balance checks in sequence).

## 5. Keeping the app "lite"

Concrete budgets, not vibes:

| Budget                        | Target                                                                                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold start (mid-tier Android) | < 2.5s to first interactive chat list                                                                                                                                               |
| APK/IPA size                  | < 40 MB at v1 GA                                                                                                                                                                    |
| JS bundle (Hermes bytecode)   | < 6 MB                                                                                                                                                                              |
| Chat image upload             | Client-side resize to max 1600px longest edge, WebP, before upload                                                                                                                  |
| Status media                  | Max 15s video, transcoded to H.264 720p, or single compressed image (video not yet built — Batch F, session 18, shipped photo + text only; see `docs/02-DATA-MODEL.md` §10 for why) |
| Avatar                        | 256×256 max, served via Supabase Storage image transform                                                                                                                            |
| Dependencies                  | Every new package requires a one-line justification in the PR description; prefer Expo-provided modules over third-party                                                            |
| Animation                     | Reanimated (runs on UI thread) over `Animated` API or heavy Lottie files; Lottie reserved for rare empty-state illustrations under 50KB                                             |

## 6. Environments

`development` → `staging` → `production`, each a separate Supabase project and separate Flutterwave/Paystack keys (test vs live). CI (GitHub Actions) runs migrations against `staging` on merge to `main`, promotes to `production` on tagged release only, manually approved.

## 7. Related docs

- Schema & locking detail: `docs/02-DATA-MODEL.md`
- Pricing/fee formulas: `docs/03-ECONOMY-LEDGER.md`
- Function-by-function API contracts: `docs/05-API-REALTIME-SPEC.md`
- Threat model: `docs/06-SECURITY-FRAUD-LOOPHOLES.md`
