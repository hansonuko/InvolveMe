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
