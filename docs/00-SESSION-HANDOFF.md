# 00 — Session Handoff

Living doc. Read this first in any new session before touching the repo — it's the "what's actually true right now" snapshot that the other numbered docs (which describe the _target_ design) don't capture. Update it at the end of every phase/PR, not just when someone remembers to.

## Snapshot as of 2026-09-12

**Repo:** https://github.com/hansonuko/InvolveMe (public, proprietary license)
**Supabase project:** `InvolveMe`, ref `ekotjsmgfluufsoralmf`, region `eu-west-1`, Postgres 17.6, status `ACTIVE_HEALTHY`, linked locally via the Supabase CLI (`supabase/config.toml`).
**Payments:** Flutterwave account not yet provisioned — Phase 3 blocker, not needed yet.

## What's actually merged into `main`

| PR             | What                                                                        | Status              |
| -------------- | --------------------------------------------------------------------------- | ------------------- |
| #1             | Phase 0: monorepo scaffold, design tokens, nav shell, phone/OTP auth wiring | Merged              |
| #2             | Supabase CLI linked to the real dev project                                 | Merged              |
| #3             | Phase 1 item 1: full ledger/wallet schema, applied to the dev DB            | Merged              |
| (this session) | Phase 1 items 2+3: RLS policies + `SECURITY DEFINER` money-moving functions | Open PR — see below |

**The core money path now works end-to-end against the real dev database.** A real two-user scenario was run and verified, not just "it compiled": top up → send message → reply → escrow release → auto-conversion to cash → withdrawal → compensating refund on a failed payout. This is the first point in the project where that's true.

Still missing before the _app_ can drive any of this: the Edge Functions that actually call these RPCs (nothing calls `fn_send_message` etc. yet except the verification scripts), real Flutterwave integration, KYC/bank-linking flows, and the cron wiring for the two sweep jobs + reconciliation check (item 5). The functions those crons need (`fn_refund_expired_escrows`) already exist — only the schedule is missing.

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
- No Edge Functions yet — the RPCs are locked to `service_role` only (verified: `REVOKE EXECUTE ... FROM PUBLIC` on every function), so nothing outside a trusted server context can call them, but nothing _is_ calling them yet either. The mobile app still can't send a real message.
- No content moderation, no KYC vendor integration, no age gate yet — all required before public launch per `docs/07-COMPLIANCE-LEGAL.md` §6, not required for continued dev-phase work.
- Concurrency tests (item 6) haven't been written — the functions rely on `SELECT ... FOR UPDATE` row locks for correctness under concurrent calls, which hasn't been load-tested, only reasoned about.
- `users_select_own_or_thread_partner` policy exposes the full `users` row (including phone number) to thread partners rather than a column-limited subset — documented v1 simplification, see the RLS migration's header comment.

## Immediate next step

Phase 1 items 2+3 are done and verified (see above), sitting in an open PR awaiting merge. Next up: item 5 (wire `fn_refund_expired_escrows`, an auto-withdrawal sweep, and the ledger-vs-balance reconciliation check to `pg_cron`) and item 6 (concurrency tests) — or, arguably higher-value next, the actual Edge Functions (`send-message`, `buy-credit`, `withdraw`) that let the mobile app call any of this for real. See `docs/08-BUILD-PHASES-ROADMAP.md` Phase 1 and Phase 2.
