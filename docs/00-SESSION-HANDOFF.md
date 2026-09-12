# 00 — Session Handoff

Living doc. Read this first in any new session before touching the repo — it's the "what's actually true right now" snapshot that the other numbered docs (which describe the _target_ design) don't capture. Update it at the end of every phase/PR, not just when someone remembers to.

## Snapshot as of 2026-09-12

**Repo:** https://github.com/hansonuko/InvolveMe (public, proprietary license)
**Supabase project:** `InvolveMe`, ref `ekotjsmgfluufsoralmf`, region `eu-west-1`, Postgres 17.6, status `ACTIVE_HEALTHY`, linked locally via the Supabase CLI (`supabase/config.toml`).
**Payments:** Flutterwave account not yet provisioned — Phase 3 blocker, not needed yet.

## What's actually merged into `main`

| PR  | What                                                                        | Status |
| --- | --------------------------------------------------------------------------- | ------ |
| #1  | Phase 0: monorepo scaffold, design tokens, nav shell, phone/OTP auth wiring | Merged |
| #2  | Supabase CLI linked to the real dev project                                 | Merged |
| #3  | Phase 1 item 1: full ledger/wallet schema, applied to the dev DB            | Merged |
| #4  | Phase 1 items 2+3: RLS policies + `SECURITY DEFINER` money-moving functions | Merged |
| #5  | Phase 1 item 5: scheduled jobs (pg_cron) + frozen-wallet enforcement        | Merged |
| #6  | Phase 1 item 6: concurrency + ledger-conservation test suite                | Merged |

**Phase 1 is complete and merged.** The core money path works end-to-end against the real dev database, including its safety nets, and has a committed, re-runnable test suite proving the locking actually holds under genuine concurrent load — not just reasoned about.

**Phase 2 batch 1 (`send-message`) is built and tested, PR open, not yet merged** — see the dedicated section below. Every other RPC is still locked to `service_role` with nothing calling it — batch 2 (`buy-credit`, `webhook-flutterwave`, `withdraw`) is still unbuilt, blocked on Flutterwave credentials as originally scoped.

### Phase 2 batch 1 — `send-message` Edge Function (PR open, not yet merged — see PR #8)

Built: `supabase/functions/_shared/auth.ts` (JWT verification helper — every Edge Function that touches money uses this to re-derive the caller's identity server-side, per CLAUDE.md rule #1, rather than trusting a body-supplied user id) and `supabase/functions/send-message/index.ts`.

**Contract decisions made while building (both applied to `docs/05-API-REALTIME-SPEC.md`, not left to drift):**

1. Request accepts `{ thread_id?, recipient_id?, body }` as the handoff doc recommended — missing `thread_id` validates and calls `fn_start_thread` with the caller as participant_a/payer.
2. **Response now also returns `thread_id`.** The original spec's 200 response never included it — with no way to learn the thread you just started, a client could open a conversation but never continue it. Found while writing the test's reply step, not anticipated going in.
3. **A reply must use the returned `thread_id`, not `recipient_id`.** `fn_start_thread(payer, payee)` looks up `(participant_a, participant_b)` as an _ordered_ pair — the payee replying with `recipient_id` set to the payer would look up (and, finding none, create) a second, reversed-role thread instead of continuing the first. Documented in docs/05 so this doesn't get rediscovered the hard way by a client implementation.

**Verified against the real dev database, through the actual HTTP function** (not by calling `fn_send_message` directly, matching the handoff's exit criteria): two Admin-API-created test users, real minted JWTs (HS256, signed with `SUPABASE_JWT_SECRET`, no external JWT library), a full paid exchange — A opens a thread with a 30-word message (2 credits), B replies with 60 words (4 more credits, still debited from A — B never pays, only earns), both escrows release in the same call, B's earnings convert immediately to `withdrawable_cash` (5000 kobo), platform earns its cut (1 credit), ledger conservation holds on every wallet touched. Plus the full documented error mapping: 401 (missing/invalid auth), 400 (empty body, neither `thread_id` nor `recipient_id`, self-threading, 501-word cap), 404 (`recipient_not_found`), 402 (`insufficient_credit` with the structured `credits_required`/`credits_available` shape). 20/20 assertions passing. All test data cleaned up afterward, confirmed zero rows left.

**Environment gap found this session, worked around:** `supabase functions serve` (the handoff's documented local-test path) shells out to Docker for its local edge-runtime gateway, and this dev machine has neither Docker nor Podman installed. Asked the user how to proceed rather than guessing; chose installing a standalone Deno CLI binary and running the function directly via `deno run -A supabase/functions/send-message/index.ts` (`Deno.serve` is native Deno, not a Supabase CLI wrapper) with `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` set to the real linked dev project — same env vars the CLI's gateway would inject. `_shared/auth.ts` does its own `auth.getUser()` check regardless of which gateway is in front of it, so this isn't a verification gap, just a different way of reaching the same code path. The Deno binary download itself was badly throttled on this network (~15KB/s from GitHub's releases CDN, repeated resets; ~5x faster from `dl.deno.land` directly) — worth knowing if a future session hits the same thing. Documented in `supabase/tests/README.md`; swap back to `supabase functions serve` once Docker is available, the test's spawn call is the only thing that changes.

**A real bug in the test harness itself, caught before it caught anything in the function:** the first version of `deleteTestUser` in the new test file used the Admin API's `DELETE /admin/users/:id` for cleanup. That works for an _unfunded_ test user, but any wallet with `ledger_entries` against it can't cascade-delete through `auth.users` — `ledger_entries` is deliberately append-only (a trigger blocks deletes, per CLAUDE.md rule #4), and the Admin API's delete hits that FK violation and returns 500 without surfacing it anywhere the test would notice, leaving two funded test users stranded. Caught by directly querying the DB for recently-created rows after a run rather than trusting a clean exit code. Fixed by switching `deleteTestUser` to the same disable-trigger / delete-ledger-entries / re-enable-trigger / delete-dependent-rows sequence `wallet-functions.test.js` already established, rather than reinventing it. Same run also silently hung for two full minutes after every assertion had already logged and passed, with no summary line and no error — root-caused to something not draining Node's event loop after cleanup (most likely the killed `deno` child process's stdio pipes); fixed with an explicit `process.exit()` at the end of `main()` rather than relying on natural event-loop drain. Both fixes verified by rerunning to a clean, fast exit with the same 20/20 result.

**Not done, by original scope, not an oversight:** `buy-credit`, `webhook-flutterwave`, `withdraw` (batch 2 — blocked on Flutterwave credentials), `post-status` (needs a new DB function first), `kyc-callback` (no KYC vendor chosen yet), and actually deploying anything (`supabase functions deploy`) — local testing only so far, deploy was explicitly scoped as a later step once more of the batch is verified.

### Phase 1 item 6 — what was verified, not just written

A **permanent, committed** test suite (`supabase/tests/wallet-functions.test.js`, run via `npm run test:db`), not a scratch script — it stays in the repo for the next person (or the next database change) to re-run. Fires genuinely concurrent requests from separate physical connections (a single `pg.Client` processes queries serially even unawaited; real concurrency needs real separate connections) against the real dev database:

- Two simultaneous `fn_send_message` calls against a wallet funded for exactly one message → exactly one succeeds, the other gets `insufficient_credit`, balance never goes negative, ledger reconciles
- Two simultaneous `fn_confirm_topup` calls for the same topup (a racing duplicate webhook, not a sequential retry) → credits issued exactly once, not twice
- Two simultaneous `fn_initiate_withdrawal` calls against a wallet funded for exactly one withdrawal → exactly one succeeds
- Two independent concurrent conversations (4 users, 4 connections, 4 simultaneous sends) → every wallet touched, including both platform wallets, reconciles against its own ledger sum afterward

11/11 passing. All test data cleaned up automatically after each run — confirmed zero rows left anywhere.

### Bugs this test suite caught in itself before it caught anything in the functions

Worth recording because they're exactly the kind of test-infrastructure mistake that quietly invalidates a test suite's results if not caught:

1. **Cross-user cleanup ordering.** A thread's messages can have `sender_id` pointing at _either_ participant, so tearing down "everything belonging to user X" one user at a time left the other participant's messages dangling and blocked the thread delete with an FK violation. Fixed by adding a `deleteTestThread` helper that tears down a thread as a unit, by thread id, before either participant is deleted.
2. **Platform wallet cleanup drift.** `resetPlatformWallets` zeroed `wallets.balance` directly without deleting the corresponding `ledger_entries` — exactly the bug class `fn_run_reconciliation_check` exists to catch — which leaked a stale mismatch into whichever test ran next. Fixed by deleting the ledger rows too, not just the cached balance.
3. **Deterministic phone numbers.** Test users originally used a fixed counter (`+234000100005`, etc.) for their phone number. A run that crashed before cleanup (which happened twice, from bugs 1 and 2 above) left those numbers taken, so the next run's `INSERT` failed on `users_phone_key` before the actual test logic even ran. Fixed by randomizing the phone number per run, same as the user ID already was.

None of these were bugs in the database functions themselves — the functions passed every time once the test harness itself was correct. Worth noting: **this suite is intentionally not wired into CI** (it runs real inserts/deletes against whatever `SUPABASE_DB_URL` points at, which should only ever be a dev/staging project) — it's a manual pre-merge check for now, run via `npm run test:db`.

**Operational note, not a code issue:** the dev pooler (`aws-1-eu-west-1.pooler.supabase.com`) dropped connections mid-session and once timed out on auth entirely across several runs while building this suite — always recoverable on retry, never a partial/incorrect result. Added a `client.on('error', ...)` handler so a drop fails the affected test cleanly instead of crashing the whole process with an unhandled exception. Worth keeping an eye on once real traffic exists; not urgent now.

### Phase 1 item 5 — what was verified, not just written

Ran against the real dev database (fresh test users each time, cleaned up afterward, confirmed zero rows left):

- `pg_cron` enabled successfully on the dev project; all three jobs registered and confirmed via `cron.job` with the right schedules: `escrow-expiry-sweep` (`*/15 * * * *`), `auto-withdraw-sweep` (`0 * * * *`), `reconciliation-check` (`5 * * * *`)
- `fn_run_reconciliation_check`: a deliberately corrupted wallet (balance set directly, bypassing the ledger — the exact bug class this exists to catch) is detected, frozen, and logged to `fraud_signals` with severity `high`; a clean wallet reports zero mismatches
- `fn_run_auto_withdraw_sweep`: a below-minimum balance is correctly left alone before the 7-day force window, then correctly swept once past it; a wallet with no verified bank account is excluded entirely (held, not force-paid); a mid-sweep failure (KYC dropped after aging) is caught, logged to `fraud_signals`, and doesn't crash the sweep for other wallets
- **Frozen-wallet enforcement, added this session after noticing it didn't exist:** `fn_send_message` now rejects a frozen payer wallet, `fn_release_escrow` now rejects a frozen payee wallet (and the whole `fn_send_message` call rolls back — the payer isn't charged for a reply that fails to release), `fn_confirm_topup` and `fn_initiate_withdrawal` reject frozen wallets too; `fn_refund_expired_escrows` skips (not aborts) a frozen payer's escrow so the bulk sweep still processes everyone else

### The gap that made item 5 necessary to extend beyond its original scope

`fn_run_reconciliation_check` sets `wallets.is_frozen` on a mismatch, but nothing anywhere actually _checked_ that flag — freezing a wallet did nothing to stop further activity on it, which defeats the point per `docs/02-DATA-MODEL.md` §4. Added `is_frozen` guards to every wallet lock in every money-moving function (`20260912082046_guard_frozen_wallets.sql`, `CREATE OR REPLACE` — no function signatures changed, so grants/permissions carried over automatically). Not something the roadmap called out as its own item; found while writing this doc's summary of item 5, on the theory that it belongs with the reconciliation check rather than as a separate future fix.

### Two things intentionally left as documented gaps in item 5 (not silent, not blocking)

- **"Notify" half of "hold and notify" isn't implemented.** A user without a verified bank account is correctly excluded from the auto-sweep, but nothing pushes them a reminder to add one — that needs an Edge Function + push service that doesn't exist yet.
- **Reconciliation "pages on-call" isn't implemented either** — a mismatch freezes the wallet and logs a high-severity `fraud_signals` row, which is the detectable/actionable part, but nothing pages anyone; that needs an external alerting integration.
- **The auto-sweep's "how long has this sat unwithdrawn" check uses `wallets.updated_at` as a proxy**, which is exact only when withdrawals always take the full balance (which `fn_initiate_withdrawal` defaults to). A partial withdrawal would reset the clock on older money still in the same wallet. Documented in the migration; exact per-credit aging would need dedicated tracking this migration doesn't add.

### Phase 1 items 2+3 — what was verified, not just written

Ran against the real dev database with two real test users (created via the Admin API, then fully cleaned up in FK-safe order — confirmed zero rows left in any table afterward, platform wallets reset to 0):

- `fn_buy_credit` on a ₦1,000 top-up computes exactly ₦20 fee / 98 credits; `fn_confirm_topup` issues them and is a no-op on a retried/duplicate call (webhook-retry safe)
- `fn_start_thread` is find-or-create, not create-every-time
- A (payer) sends a 30-word message → 2 credits charged, escrowed, **not** yet earned by B
- B (payee) replies with a 60-word message → 4 more credits charged to A, **and** releases both the earlier escrow and this new one in the same call (per docs/03 §5's "up to and including this exchange") — A ends up debited 6 credits total, B ends up with **5000 kobo in `withdrawable_cash`**, platform earns **1 credit**, `earnings_pending` nets back to zero (auto-converted immediately, matching the doc's worked-example rounding exactly: 2×80%→2/0, 4×80%→3/1)
- Insufficient-balance and >500-word messages are both rejected with the expected error codes
- `fn_initiate_withdrawal` debits `withdrawable_cash` immediately; `fn_fail_withdrawal` correctly reverses that debit and marks the withdrawal `failed` (the compensating path for when a provider transfer call fails after the DB already committed)
- Withdrawal below the ₦500 minimum is rejected without the bypass flag; a KYC-tier-0 user is rejected outright
- Anon key still gets zero rows / denied writes on every table (RLS posture unchanged by adding read policies for `authenticated`)

### Two real bugs found and fixed during this build (not hypothetical — both would have shipped broken otherwise)

1. **`make_interval(hours => v_refund_hours)` failed at runtime** — `pricing_config.value` is `bigint`, `make_interval` wants `integer`, and Postgres won't implicitly narrow in a named-argument function call. Fixed with an explicit cast. Caught by actually calling the function, not by the migration applying cleanly (DDL applies fine; the bug only shows up when the function body executes).
2. **Earnings never actually became withdrawable.** The original function only credited `earnings_pending` at escrow release and stopped there — nothing converted it to `withdrawable_cash`, contradicting docs/03-ECONOMY-LEDGER.md §6's "automatically and immediately on release." Fixed by adding the conversion as two more ledger legs in the same release transaction (debit `earnings_pending`, credit `withdrawable_cash`, both reason `earnings_conversion` — which is exactly why that reason already existed in the item-1 CHECK constraint enum).

### One schema correction made mid-session (forward migration, nothing hand-edited)

The item-1 schema had a single `platform_revenue` wallet kind, but top-up fees are cash (kobo) and earnings-take fees are credits — two different units that can't share one balance without silently mixing them. Split into `platform_revenue_topup_fees` and `platform_revenue_earnings_cut` via a new migration (`20260912072739_extend_schema_for_functions.sql`), which also added the `withdrawal_refund_failed` ledger reason needed for `fn_fail_withdrawal`.

### One workflow mistake worth remembering for next time

Pre-created all four migration files via `supabase migration new` before writing their content, then ran `supabase db push` — which applied the still-empty files and marked them "applied" in the remote's migration history. Editing them afterward meant `db push` would silently skip the real content on the next run (matches by filename/timestamp, not content). Fixed by deleting the stale rows from `supabase_migrations.schema_migrations` and re-pushing, but the correct sequence is: **write a migration's full content before pushing it, not batch-create-then-fill.**

### A schema behavior worth knowing, not a bug

`threads.participant_a/b` reference `users(id)` **without** `ON DELETE CASCADE` (unlike `wallets`, which does cascade from `users`). This means a user with any thread history can't be hard-deleted — consistent with `ledger_entries` already being permanently undeletable once it exists. For a money-moving app this is probably the right default (can't erase transaction/conversation history via account deletion), but it means "delete a user" will need to become "suspend/anonymize a user" as a product decision later, not literal `DELETE FROM users`.

## Credentials status

Real dev credentials are configured locally in `.env` (root, server-only) and `apps/mobile/.env` (client-safe subset) — **neither file is committed**, confirmed via `git check-ignore`. If you're picking this up fresh: ask whoever has them, or pull them from the Supabase dashboard (Project Settings → API, and Settings → Database for the pooler connection string) — this doc intentionally never contains the actual values.

- ✅ `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — verified live (HTTP 200 against Auth API)
- ✅ `SUPABASE_SERVICE_ROLE_KEY` — verified live (HTTP 200 against the admin-only `/auth/v1/admin/users` endpoint). Note: the first value provided for this turned out to be a duplicate of the anon key (decoded to `role:"anon"`) — caught by decoding the JWT before trusting it, corrected value confirmed separately.
- ✅ `SUPABASE_DB_URL` (pooler connection string) — verified live (`PostgreSQL 17.6`)
- ✅ `SUPABASE_JWT_SECRET` — populated, not independently verified (nothing signs custom JWTs yet)
- ✅ `SUPABASE_ACCESS_TOKEN` — verified live (`supabase projects list`, `supabase link`, and every `db push` in this session)
- ❌ Flutterwave keys — not provisioned (Phase 3)
- ❌ KYC vendor keys — not provisioned (Phase 3)

**Hygiene note carried forward:** the DB password and CLI access token were shared in a chat message. Worth rotating both from the Supabase dashboard at some point as routine practice for a money-moving app — not urgent, hasn't blocked anything.

## Key decisions on record (deviations from the original verbal brief — don't "fix" these back without re-reading why)

1. **Stack:** React Native (Expo) + Supabase (Postgres/Auth/Realtime) + Flutterwave-first with Paystack provisioned behind a `PaymentProvider` interface. User-selected from options presented; see conversation history if the reasoning matters later.
2. **Message pricing is tiered**, not flat: `2 × ceil(words / 50)` credits with a 500-word hard cap — the literal brief's flat "+2 credits over 50 words, no cap" is exploitable (see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §1). Matches the brief exactly at the two points it specified (≤50 words, just-over-50). **Now implemented and verified** in `fn_send_message`.
3. **Escrow mechanic added, not in the original brief:** credits charged to the payer are held until the payee actually replies, auto-refunded if unanswered after 48h. Closes a fairness gap (payer charged into a void) the literal brief didn't address. **Now implemented** (`fn_send_message` + `escrows` table); `fn_refund_expired_escrows` exists but isn't cron-scheduled yet (item 5).
4. **Earnings auto-convert to cash immediately** on escrow release (fixed ₦10/credit rate) rather than requiring a manual "convert" step with a floating rate — simplification, see `docs/03-ECONOMY-LEDGER.md` §6 for why. **Now implemented and verified** in `fn_release_escrow`.
5. **Web target de-scoped.** Expo's template defaults to web + static SSR export; that crashed under Node SSR (AsyncStorage touches `window`) and was never actually a v1 goal (WhatsApp-shaped app is mobile-first). Switched to `single` (client-only) output. See PR #1.
6. **2% top-up fee likely doesn't cover the payment gateway's own processing fee** — flagged as an unresolved business-model question in `docs/03-ECONOMY-LEDGER.md` §3, not something the code can fix. Needs a real decision before launch (subsidize it, raise it, or floor top-up amounts).
7. **The `escrow_hold` ledger reason (from item 1) is deliberately unused.** A separate clearing-account ledger leg at hold time would need its own wallet abstraction; the `escrows` table itself already records what's held, and the per-wallet reconciliation invariant CLAUDE.md cares about doesn't require it. Documented in the functions migration's header comment.
8. **`wallet_float_kobo` dust-carry mechanic (docs/03 §3) is not implemented.** Top-up rounding remainders (sub-10-kobo) are currently just not credited anywhere — a real, small, deliberately-deferred gap, not silently dropped.

## Open risks / known gaps

- Service-role key rotation still pending (see hygiene note above).
- `send-message` is the only Edge Function built so far (batch 1, PR open — see the dedicated section above); `buy-credit`/`webhook-flutterwave`/`withdraw` (batch 2) and `post-status`/`kyc-callback` remain unbuilt, and nothing has been deployed yet (`supabase functions deploy`) — local-only so far. The mobile app still can't buy credit or withdraw cash for real.
- This dev machine has no Docker/Podman, so `supabase functions serve` can't run locally — worked around this session with a standalone Deno CLI install (see the batch 1 section above). Worth fixing properly (install Docker) before it blocks something bigger than one function.
- No content moderation, no KYC vendor integration, no age gate yet — all required before public launch per `docs/07-COMPLIANCE-LEGAL.md` §6, not required for continued dev-phase work.
- `users_select_own_or_thread_partner` policy exposes the full `users` row (including phone number) to thread partners rather than a column-limited subset — documented v1 simplification, see the RLS migration's header comment.
- The three "notify/page a human" halves of item 5's jobs (bank-account reminder push, on-call paging for reconciliation mismatches) aren't implemented — the detection/enforcement side is real, the human-notification side needs infrastructure that doesn't exist yet (see item 5 section above).
- `fn_run_auto_withdraw_sweep`'s "how long has this sat" check is a `wallets.updated_at` proxy, not exact per-credit aging (see item 5 section above).
- `supabase/tests/wallet-functions.test.js` is a manual check (`npm run test:db`), not wired into CI — it runs real inserts/deletes against whatever `SUPABASE_DB_URL` points at. Automating it would need a dedicated ephemeral test database, not the shared dev project.

## Immediate next step — Edge Functions batch 2 (scoped, not yet built)

Batch 1 (`_shared/auth.ts` + `send-message`) is **done** — built, tested end-to-end against the real dev database, PR open (see the dedicated section above). This is the plan for the next session: go straight to Batch 2 below unless something has changed.

### Why this was split into two batches

Flutterwave and KYC vendor credentials aren't provisioned (see Credentials status above). Batch 1 was everything fully buildable _and testable end-to-end_ against the real dev database with what already existed. Batch 2 needs a payment provider account before it can be tested for real, even though the code can be written against Flutterwave's public API docs in the meantime.

### Batch 1 — done (reference only)

| Function          | Calls                                                                                   | Notes                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_shared/auth.ts` | —                                                                                       | Shared helper: verify the caller's JWT (via `supabase-js` + the incoming `Authorization` header), return the authenticated user id. Every function below uses this — build it first. |
| `send-message`    | `fn_start_thread` (if `thread_id` not supplied — see decision below), `fn_send_message` | Core function, highest value, zero external dependencies.                                                                                                                            |

**Contract decision made when building:** `docs/05-API-REALTIME-SPEC.md`'s `send-message` contract only took `{ thread_id, body }` — there was no documented "start a new conversation" call. Built to accept `{ thread_id?, recipient_id?, body }`: if `thread_id` is missing, `fn_start_thread(caller_id, recipient_id)` runs first. The response also now returns `thread_id` (an addition beyond the original recommendation — see the batch 1 section above for why). `docs/05-API-REALTIME-SPEC.md` updated to match.

**Error mapping** (`fn_send_message` raises these `raise exception` messages — map to HTTP status in the Edge Function, per the convention in `docs/05-API-REALTIME-SPEC.md` §5):

| DB error              | HTTP status                                                        |
| --------------------- | ------------------------------------------------------------------ |
| `thread_not_found`    | 404                                                                |
| `not_a_participant`   | 403                                                                |
| `thread_blocked`      | 403                                                                |
| `wallet_frozen`       | 403                                                                |
| `empty_message`       | 400                                                                |
| `message_too_long`    | 400                                                                |
| `insufficient_credit` | 402 (matches the worked example in `docs/05-API-REALTIME-SPEC.md`) |

**Testing without real phone/SMS:** don't wait on OTP delivery to get a real JWT for testing. `SUPABASE_JWT_SECRET` is already in `.env` — mint a test access token directly with a JWT library (`sub` = a real test user's id created via the Admin API, `role: authenticated`, matching Supabase's expected claim shape) rather than trying to receive a real SMS OTP in a dev script. `supabase functions serve` runs the function locally while still talking to the real linked dev project (pass `--env-file` pointing at `.env`) — no separate local Postgres needed, consistent with how everything else this project has been tested. **In practice this session, `functions serve` needed Docker, which wasn't available — see the batch 1 section above for the `deno run` workaround actually used.**

**Exit criteria — met:** two real test users held a full paid conversation through the actual `send-message` Edge Function (not by calling `fn_send_message` directly, the way `supabase/tests/` does) — top-up balance decrements, escrow releases, earnings land in `withdrawable_cash`, verified via the same kind of test-then-cleanup discipline every other phase this session used. Test data cleaned up afterward, confirmed zero rows left, same standard as every prior PR. See `supabase/tests/send-message-function.test.js`.

### Batch 2 — build now, mark "written, untested against live Flutterwave"

| Function                           | Calls                                                                                                                 | Notes                                                                                                                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/payments/flutterwave.ts` | Flutterwave's public REST API                                                                                         | Implements the `PaymentProvider` interface from `packages/payments/provider.ts`. Can be written against Flutterwave's published API docs without live keys; just can't be exercised end-to-end until an account exists.                                                         |
| `buy-credit`                       | `fn_buy_credit`, then `PaymentProvider.initiateCollection()`                                                          |                                                                                                                                                                                                                                                                                 |
| `webhook-flutterwave`              | Signature verification (`PaymentProvider.verifyWebhook()`), `provider_event_id` idempotency check, `fn_confirm_topup` | Signature verification logic can be written and unit-tested with a synthetic secret in `.env` even without a real Flutterwave account — swap the placeholder for the real `FLW_WEBHOOK_SECRET_HASH` once provisioned.                                                           |
| `withdraw`                         | `fn_initiate_withdrawal`, then `PaymentProvider.initiatePayout()`; on provider failure, `fn_fail_withdrawal`          | The two-step "DB commits the debit, then the provider call happens" sequence is exactly why `fn_fail_withdrawal` exists (see Phase 1 items 2+3 section) — make sure the Edge Function actually calls it on a provider-side failure, don't let that compensating path go unused. |

### Explicitly not in this batch

- **`post-status`** — needs a new DB function (`fn_post_status` or similar) that doesn't exist yet; Phase 1's function set never included status uploads. Small, analogous to `fn_buy_credit` in complexity, but it's new DB work, not just an Edge Function wrapping something that already exists. Scope separately when Status (Phase 6) comes up.
- **`kyc-callback`** — needs a KYC vendor (Smile Identity, Dojah, VerifyMe, etc.) that isn't chosen or provisioned yet. Fully deferred.
- **Actually deploying** these functions (`supabase functions deploy`) — local `functions serve` testing first; deploy is a separate, later step once Batch 1 (and ideally Batch 2) are verified.
