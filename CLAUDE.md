# CLAUDE.md — InvolveMe

Standing brief for any AI agent (or human) writing code in this repo. Read fully before touching anything under `apps/` or `supabase/`.

## What this app is

InvolveMe is a WhatsApp-shaped chat app where messaging is pay-per-message. Full product/economic spec lives in `docs/`. **Read `docs/03-ECONOMY-LEDGER.md` and `docs/06-SECURITY-FRAUD-LOOPHOLES.md` before writing any code that touches credits, wallets, messages, or payments.** Those two documents are the source of truth for pricing, not the original verbal brief — they contain hardened versions of the rules with the loopholes closed.

## Non-negotiable rules for this codebase

1. **No financial logic on the client.** The RN app never computes credit costs, fee splits, or balances — it only displays numbers returned by the server and calls Edge Functions. Every function in `docs/03-ECONOMY-LEDGER.md` that touches money must be a Postgres function (`SECURITY DEFINER`, called via RPC or Edge Function), never client-side arithmetic that gets trusted.
2. **Money is integers.** All amounts are stored and passed as kobo (`bigint`) or whole credits (`bigint`). Never use `float`/`numeric` for anything that represents currency in transit. Convert to `₦X.XX` only at the presentation layer.
3. **Every balance mutation is one atomic transaction.** Debiting a sender, crediting an escrow, releasing an escrow to a receiver, taking a platform cut — these always happen together inside a single Postgres transaction with row-level locking (`SELECT ... FOR UPDATE`) on the wallet rows involved, keyed so concurrent messages from the same user serialize. See `wallets_ledger` design in `docs/02-DATA-MODEL.md`. Never "debit now, credit later in a separate call."
4. **Every ledger mutation is double-entry and append-only.** Balances are a derived/cached sum, not a mutable field you decrement in place without a corresponding `ledger_entries` row. If a number in a wallet doesn't reconcile against the sum of its ledger entries, that's a bug, not a rounding quirk.
5. **All payment provider calls go through the `PaymentProvider` interface** (`packages/payments/`), never call the Flutterwave SDK directly from a feature module. This is what lets Paystack be added later per the product decision on record.
6. **Webhook handlers are idempotent and signature-verified**, full stop. Every Flutterwave/Paystack webhook must check a stored `provider_event_id` before processing, and reject anything that fails signature verification — no exceptions for "just testing."
7. **Nothing withdraws to an unverified bank account.** KYC tier + bank account name-match gates every withdrawal path, including the automatic 24-hour sweep. If you're implementing the auto-withdrawal cron and there's no verified destination, the correct behavior is to hold and notify, never to skip verification.
8. **Word-count billing uses the tiered formula in `docs/03-ECONOMY-LEDGER.md`** (`2 × ceil(words / 50)` credits, capped message length), not a flat "+2 credits over 50 words" rule — the flat rule is exploitable and is documented as such in `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §1.
9. **Pricing numbers are config, not constants.** Credit unit price, base message cost, status-upload cost, platform take-rates, withdrawal thresholds — all of these live in the `pricing_config` table (see data model), read at request time by Edge Functions, never hardcoded in application code. Product/ops must be able to tune the economy without an app release.
10. **Stay "lite."** No heavy chat SDKs, no unbounded local caches, no full-resolution media by default (see media pipeline in `docs/01-ARCHITECTURE.md`). Before adding a dependency, check whether Reanimated/Moti/Expo modules already cover it. Bundle-size and cold-start-time budgets are tracked in `docs/08-BUILD-PHASES-ROADMAP.md` — treat regressions past those budgets as build-blocking, same severity as a failing test.
11. **Every `SECURITY DEFINER` function must explicitly `revoke execute ... from public, anon, authenticated` and `grant execute ... to service_role` immediately after its `create function` statement, in the same migration.** This project's entire SECURITY DEFINER function set was directly callable by any client holding just the public anon key from Phase 1 until `20260915161500_lock_security_definer_execute_grants.sql` fixed it (session 14) — `revoke ... from public` alone does not work on this Supabase project (its default-ACL setup grants `anon`/`authenticated` execute directly, not via the `PUBLIC` pseudo-role), and confirmed by direct live testing, `ALTER DEFAULT PRIVILEGES ... REVOKE FROM PUBLIC` does **not** reliably stop a brand-new function from getting `PUBLIC` execute either (root cause not fully pinned down — a platform-level mechanism, not this codebase's migrations). The only verified-reliable fix is the explicit per-function statement, every time, no exceptions — see that migration's header comment for the full investigation.

## Security & Hardening Rules (see `docs/19-SECURITY-HARDENING-SCOPING.md` for the full review this was drawn from)

- Message/status/media content is encrypted in transit (TLS, Supabase-managed) and at rest (Postgres/Storage disk encryption, Supabase-managed) — this is **not** end-to-end encryption, and no UI copy, marketing material, or ToS language may imply otherwise unless real E2EE (`docs/19` §0 Path 2) is actually built. Server-side content moderation depends on plaintext access; do not encrypt message content in a way that breaks it without an explicit decision to redesign moderation first.
- Every Edge Function request body is validated with a Zod schema (`safeParse` via `_shared/validate.ts`'s `parseBody`/`requiredString`/`requiredUuid`/`requiredBoolean` helpers) before any other logic runs — no hand-rolled `typeof x !== 'string'` checks for new functions. Exception: a field already validated by an existing, reused, non-Zod helper (e.g. `_shared/twoStep.ts`'s `isValidPinFormat`) stays on that helper rather than gaining a second, parallel Zod copy of the same rule.
- No `SECURITY DEFINER` function or Edge Function ever builds a SQL string by concatenating or interpolating request data — RPC calls and the Supabase query builder's parameterized filters only, no exceptions.
- No secrets, API keys, or service-role credentials are ever hardcoded; every one is read via `Deno.env.get()`/`process.env` with an explicit failure (never a silent fallback) if missing. `EXPO_PUBLIC_*` values are the one deliberate exception — those are meant to be public; everything else is not.
- The Supabase service-role key must never reach client-bundled code, ever — verify this on any change that touches how a client authenticates or calls an Edge Function.
- Any Edge Function accepting unauthenticated or low-cost-to-call input (OTP send, phone lookup, public pricing) is rate-limited via `fn_check_rate_limit` (`_shared/rateLimit.ts`'s `checkRateLimit`, `docs/19` §3) — Postgres-based, not a new external dependency (Redis or otherwise) without a specific, documented reason the Postgres-native approach can't scale to.
- User-facing PIN/password verification uses a pepper or salt kept out of the database the hashed value lives in (Edge Function secret, not a DB column) — see `two_step_pin_hash` and the admin dashboard's Argon2id password hashing for the two existing correct patterns; match one of them, don't invent a third.

## Working conventions

- **Language:** TypeScript everywhere (app, Edge Functions), `strict: true`. No `any` in code that touches money, auth, or the ledger.
- **State:** Zustand for local/UI state, TanStack Query for all server data — do not introduce a second data-fetching library.
- **Styling:** design tokens from `docs/04-DESIGN-SYSTEM.md` only. Never hardcode a hex color or spacing value inline — reference the token.
- **Tests:** any Edge Function under `supabase/functions/` that mutates a balance requires a test that asserts ledger conservation (sum of debits == sum of credits including the platform cut) and a concurrency test (two simultaneous calls can't double-spend). No PR merges without these for wallet code.
- **Migrations:** all schema changes go through `supabase/migrations/`, forward-only, never hand-edit the remote database.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`…). Branch off `main`, never commit directly to it.
- **Currency literal:** always `NGN` / `₦` in UI copy; don't assume other currencies are supported yet even though the code should be written currency-agnostic where cheap to do so.

## Regulatory posture (read `docs/07-COMPLIANCE-LEGAL.md`)

This product custodies user funds and moves cash between strangers based on message activity — that is money-transmission-adjacent and both Apple/Google app review and the CBN (Central Bank of Nigeria) will treat it that way. Do not ship a payout path, referral-bonus system, or credit-resale feature without checking it against that document first. When in doubt, hold the feature behind a flag and flag it for legal review rather than shipping it live.

## Where to look for X

| Need                                  | File                                         |
| ------------------------------------- | -------------------------------------------- |
| How much a message costs              | `docs/03-ECONOMY-LEDGER.md` §Message Billing |
| Wallet/table schema                   | `docs/02-DATA-MODEL.md`                      |
| Edge Function request/response shapes | `docs/05-API-REALTIME-SPEC.md`               |
| Colors, spacing, motion curves        | `docs/04-DESIGN-SYSTEM.md`                   |
| "Is this exploitable?"                | `docs/06-SECURITY-FRAUD-LOOPHOLES.md`        |
| Folder to put a new screen/module in  | `docs/09-PROJECT-STRUCTURE.md`               |
| What phase we're in / what's next     | `docs/08-BUILD-PHASES-ROADMAP.md`            |
