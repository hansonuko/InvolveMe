# Database & Edge Function tests

## `send-message-function.test.js` (Phase 2 batch 1)

End-to-end test of the `send-message` Edge Function (`supabase/functions/send-message/`)
against the real linked dev database — real HTTP requests, real minted JWTs,
real Admin-API-created test users. Run via `npm run test:functions`.

**Why this runs the function with a bare `deno run` instead of
`supabase functions serve`:** `functions serve` shells out to Docker to run
its local edge-runtime gateway, and this dev environment has neither Docker
nor Podman installed. `deno run -A supabase/functions/send-message/index.ts`
runs the exact same file directly as a plain Deno HTTP server (`Deno.serve`
is native Deno, not a Supabase CLI wrapper), with `SUPABASE_URL` /
`SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` set to point at the real
linked dev project — the same env vars the CLI's gateway would inject. The
only thing this skips is the CLI's own JWT-gate-before-invoking-the-function
step; `_shared/auth.ts` does its own `auth.getUser()` check inside the
function regardless, so that's not a verification gap, just a different way
of reaching the same code path. Worth revisiting once Docker is available —
swap back to `supabase functions serve` and this test's spawn call is the
only thing that needs to change.

Covers: a full two-user paid exchange (open thread → reply → both escrows
release → earnings convert to cash → platform take), verified against the
DB directly, not just the function's JSON response; and the documented error
mapping (401 unauthorized, 400 empty/invalid, 404 recipient not found, 400
message too long, 402 insufficient_credit with the structured
`credits_required`/`credits_available` shape).

## `post-status-function.test.js`

End-to-end test of the `post-status` Edge Function (`supabase/functions/post-status/`),
same `deno run` approach and rationale as above — no Flutterwave dependency
at all, so every path here runs against the real thing rather than a stub.
Covers: text vs. media status charging the right `pricing_config` rate,
`expires_at` landing at `created_at + 24h`, ledger conservation on the
caller's `topup_credit` wallet, and the documented error mapping (401,
400 `empty_status`/`invalid_request`, 402 `insufficient_credit` with the
structured amounts, 403 `wallet_frozen`).

# Database concurrency & ledger-conservation tests

Phase 1 item 6. These test the `SECURITY DEFINER` functions directly against
a real Postgres connection — there's no Edge Function layer yet for these to
sit behind (that's Phase 2), so this is the earliest point in the stack
where the locking behavior in `docs/02-DATA-MODEL.md` §3 can actually be
exercised under real concurrency rather than reasoned about.

Per `CLAUDE.md`'s testing rule: any code that mutates a balance needs a test
asserting **ledger conservation** (`sum(ledger_entries) == wallet.balance`
for every wallet touched) and a **concurrency test** (two simultaneous calls
can't double-spend). This suite covers both, for every function that locks a
wallet.

## Running

Requires `SUPABASE_DB_URL` pointing at a database with the full migration
set applied — **run this against a dev/staging project, never production**,
since it creates and deletes real rows (cleaned up automatically, but it's
still live traffic against whatever's connected).

```
npm run test:db
```

(`test:db` in the root `package.json` loads `.env` via Node's built-in
`--env-file` flag — no `dotenv` dependency needed.)

## What's covered

| Test                                                             | Proves                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Concurrent `fn_send_message` vs. a one-message balance           | Only one of two simultaneous sends succeeds; the loser gets `insufficient_credit`, not a negative balance                   |
| Concurrent `fn_confirm_topup` (duplicate webhook race)           | Credits are issued exactly once even when two "webhook deliveries" race, not just when retried sequentially                 |
| Concurrent `fn_initiate_withdrawal` vs. a one-withdrawal balance | Only one of two simultaneous withdrawal requests succeeds                                                                   |
| Ledger conservation after a batch of concurrent operations       | Every wallet touched has `balance == sum(ledger_entries.amount)`, checked directly against the database rather than assumed |

## Why this isn't a mocked/unit test

Row-level locking correctness (`SELECT ... FOR UPDATE`) is exactly the kind
of thing that's easy to get wrong in a way that looks correct in sequential
testing and only breaks under real concurrent access. Mocking the database
here would test nothing that actually matters — this suite deliberately
fires genuinely simultaneous requests from separate connections at the real
dev database, per `CLAUDE.md`'s instruction not to rush this phase.

## Never delete/reset the platform wallets (`platform_revenue_*`, `platform_reserve_*`)

Found 2026-09-20, while building the admin dashboard's Treasury view: a
`resetPlatformWallets`-shaped helper existed in six test files, deleting
**every** `ledger_entries` row on these four wallets and zeroing their
balance as routine cleanup. They're a **shared, global resource**, not a
fresh fixture scoped to one test run — unlike a random-UUID test user, which
is safe to delete because nothing else references it. That helper had been
silently destroying real platform revenue history on every `npm run
test:db`/`test:chargeback`/etc. run, including in CI's `test-wallet-code`
job on every PR touching `supabase/migrations/`.

If a test needs to assert something about a platform wallet's balance,
**snapshot it before the operation under test and assert the delta**
(`after - before`), never an absolute post-test value — that's already
correct regardless of whatever pre-existing balance is sitting there from
real activity or earlier test runs, and it's the pattern every fixed test
now uses (search for `revenueBefore`/`revenueAfter` in
`chargeback-functions.test.js` for a worked example, or `platformBefore`/
`platformAfter` in `group-chat-functions.test.js`). Ledger-conservation
checks (`sum(ledger_entries) == balance`) never needed this in the first
place — that assertion is inherently relative and holds regardless of
starting balance.
