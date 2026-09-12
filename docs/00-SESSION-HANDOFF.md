# 00 — Session Handoff

Living doc. Read this first in any new session before touching the repo — it's the "what's actually true right now" snapshot that the other numbered docs (which describe the _target_ design) don't capture. Update it at the end of every phase/PR, not just when someone remembers to.

## Snapshot as of 2026-09-12

**Repo:** https://github.com/hansonuko/InvolveMe (public, proprietary license)
**Supabase project:** `InvolveMe`, ref `ekotjsmgfluufsoralmf`, region `eu-west-1`, Postgres 17.6, status `ACTIVE_HEALTHY`, linked locally via the Supabase CLI (`supabase/config.toml`).
**Payments:** Flutterwave account not yet provisioned — Phase 3 blocker, not needed yet.

## What's actually merged into `main`

| PR             | What                                                                        | Status                  |
| -------------- | --------------------------------------------------------------------------- | ----------------------- |
| #1             | Phase 0: monorepo scaffold, design tokens, nav shell, phone/OTP auth wiring | Merged                  |
| #2             | Supabase CLI linked to the real dev project                                 | Merged                  |
| (this session) | Phase 1 item 1: full ledger/wallet schema as migrations                     | In progress — see below |

No wallet, chat, or payment **logic** exists yet — Phase 0 was deliberately scaffold-only. As of this session, the database schema is being built (Phase 1), but the `SECURITY DEFINER` functions that actually move money (`fn_send_message`, `fn_release_escrow`, etc.) have not been written yet. **The app cannot send a real paid message yet.**

## Credentials status

Real dev credentials are configured locally in `.env` (root, server-only) and `apps/mobile/.env` (client-safe subset) — **neither file is committed**, confirmed via `git check-ignore`. If you're picking this up fresh: ask whoever has them, or pull them from the Supabase dashboard (Project Settings → API, and Settings → Database for the pooler connection string) — this doc intentionally never contains the actual values.

- ✅ `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` — verified live (HTTP 200 against Auth API)
- ✅ `SUPABASE_SERVICE_ROLE_KEY` — verified live (HTTP 200 against the admin-only `/auth/v1/admin/users` endpoint). Note: the first value provided for this turned out to be a duplicate of the anon key (decoded to `role:"anon"`) — caught by decoding the JWT before trusting it, corrected value confirmed separately.
- ✅ `SUPABASE_DB_URL` (pooler connection string) — verified live (`PostgreSQL 17.6`)
- ✅ `SUPABASE_JWT_SECRET` — populated, not independently verified (nothing signs custom JWTs yet)
- ✅ `SUPABASE_ACCESS_TOKEN` — verified live (`supabase projects list`, `supabase link` both succeeded)
- ❌ Flutterwave keys — not provisioned (Phase 3)
- ❌ KYC vendor keys — not provisioned (Phase 3)

**Hygiene note carried forward:** the DB password and CLI access token were shared in a chat message. Worth rotating both from the Supabase dashboard at some point as routine practice for a money-moving app — not urgent, hasn't blocked anything.

## Key decisions on record (deviations from the original verbal brief — don't "fix" these back without re-reading why)

1. **Stack:** React Native (Expo) + Supabase (Postgres/Auth/Realtime) + Flutterwave-first with Paystack provisioned behind a `PaymentProvider` interface. User-selected from options presented; see conversation history if the reasoning matters later.
2. **Message pricing is tiered**, not flat: `2 × ceil(words / 50)` credits with a 500-word hard cap — the literal brief's flat "+2 credits over 50 words, no cap" is exploitable (see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §1). Matches the brief exactly at the two points it specified (≤50 words, just-over-50).
3. **Escrow mechanic added, not in the original brief:** credits charged to the payer are held until the payee actually replies, auto-refunded if unanswered after 48h. Closes a fairness gap (payer charged into a void) the literal brief didn't address.
4. **Earnings auto-convert to cash immediately** on escrow release (fixed ₦10/credit rate) rather than requiring a manual "convert" step with a floating rate — simplification, see `docs/03-ECONOMY-LEDGER.md` §6 for why.
5. **Web target de-scoped.** Expo's template defaults to web + static SSR export; that crashed under Node SSR (AsyncStorage touches `window`) and was never actually a v1 goal (WhatsApp-shaped app is mobile-first). Switched to `single` (client-only) output. See PR #1.
6. **2% top-up fee likely doesn't cover the payment gateway's own processing fee** — flagged as an unresolved business-model question in `docs/03-ECONOMY-LEDGER.md` §3, not something the code can fix. Needs a real decision before launch (subsidize it, raise it, or floor top-up amounts).

## Open risks / known gaps

- Service-role key rotation still pending (see hygiene note above).
- No `SECURITY DEFINER` functions yet — schema alone doesn't enforce the atomic-transaction rules in `CLAUDE.md` #3/#4 at the application level (the schema does enforce append-only ledger and wallet-balance-derivation at the _trigger_ level as of this session — see PR for Phase 1 item 1).
- No content moderation, no KYC vendor integration, no age gate yet — all required before public launch per `docs/07-COMPLIANCE-LEGAL.md` §6, not required for continued dev-phase work.

## Immediate next step

Phase 1 item 1 (full schema) is being built this session: `supabase/migrations/*.sql` covering every table in `docs/02-DATA-MODEL.md`, RLS enabled (deny-by-default, no policies yet — that's item 2), and a couple of schema-level integrity guarantees added beyond the doc's literal table list (documented in the PR): an append-only trigger on `ledger_entries`, a trigger that derives `wallets.balance` from `ledger_entries` automatically instead of trusting application code to keep both in sync, and signup bootstrap triggers (`auth.users` → `public.users` → three wallet rows) since nothing currently creates a `public.users` row when someone completes phone/OTP signup.

After this: item 2 (RLS policies), item 3 (`SECURITY DEFINER` functions), item 4 (`pricing_config` seed), item 5 (reconciliation cron), item 6 (concurrency tests) — see `docs/08-BUILD-PHASES-ROADMAP.md` Phase 1.
