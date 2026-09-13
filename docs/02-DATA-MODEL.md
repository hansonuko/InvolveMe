# 02 — Data Model

All monetary/credit columns are `bigint`. Kobo for NGN cash, whole credits for chat credit. Never `numeric`/`float` for either.

## 1. Core tables

### `users` (extends Supabase `auth.users`)

| Column                 | Type        | Notes                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                     | uuid PK     | = `auth.users.id`                                                                                                                                                                                                                                                                                                                       |
| phone                  | text unique | E.164 digits, **without** the leading `+` (confirmed live: Supabase Auth strips it before this trigger-copied value ever lands here) — primary identity (OTP auth, WhatsApp-style). Any code comparing against this column (e.g. `find-user-by-phone`) must strip a leading `+` from client input first, or every lookup silently 404s. |
| display_name           | text        |                                                                                                                                                                                                                                                                                                                                         |
| avatar_url             | text        |                                                                                                                                                                                                                                                                                                                                         |
| kyc_tier               | smallint    | 0 = unverified, 1 = BVN/NIN verified, 2 = enhanced (liveness) — see `docs/07-COMPLIANCE-LEGAL.md`                                                                                                                                                                                                                                       |
| status_text            | text        | "About" line                                                                                                                                                                                                                                                                                                                            |
| is_suspended           | boolean     | fraud/ops kill-switch, see `docs/06-SECURITY-FRAUD-LOOPHOLES.md`                                                                                                                                                                                                                                                                        |
| created_at             | timestamptz |                                                                                                                                                                                                                                                                                                                                         |
| device_fingerprint_ids | uuid[]      | linked device fingerprints, used for multi-account collusion detection                                                                                                                                                                                                                                                                  |

### `wallets`

One row per user per balance type — modeled as separate rows, not separate columns, so the ledger-conservation invariant is uniform.

| Column     | Type            | Notes                                                                                                                                                                                      |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id         | uuid PK         |                                                                                                                                                                                            |
| user_id    | uuid FK → users |                                                                                                                                                                                            |
| kind       | text            | `'topup_credit'` (spendable, bought with cash) · `'earnings_pending'` (credits earned, not yet cash-converted) · `'withdrawable_cash'` (kobo, converted & fee-taken, awaiting bank payout) |
| balance    | bigint          | **derived/cached** — must always equal `sum(ledger_entries.amount)` for this wallet; reconciliation job checks this hourly                                                                 |
| updated_at | timestamptz     |                                                                                                                                                                                            |

Unique constraint on `(user_id, kind)`.

### `ledger_entries` (append-only, source of truth)

| Column            | Type              | Notes                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                | uuid PK           |                                                                                                                                                                                                                                                                                           |
| wallet_id         | uuid FK → wallets |                                                                                                                                                                                                                                                                                           |
| amount            | bigint            | signed; positive = credit, negative = debit                                                                                                                                                                                                                                               |
| reason            | text              | enum-like: `topup_purchase`, `topup_platform_fee`, `message_debit`, `escrow_hold`, `escrow_release_earning`, `escrow_release_platform_cut`, `escrow_refund_unanswered`, `earnings_conversion`, `withdrawal_platform_fee`, `withdrawal_payout`, `status_upload_debit`, `manual_adjustment` |
| ref_type / ref_id | text / uuid       | polymorphic pointer to the `messages`, `topups`, `withdrawals`, or `escrows` row that caused this entry                                                                                                                                                                                   |
| created_at        | timestamptz       |                                                                                                                                                                                                                                                                                           |
| created_by        | text              | `'system'` or an admin user id, for `manual_adjustment` rows only — every manual adjustment requires a second admin's sign-off, see below                                                                                                                                                 |

No `UPDATE`/`DELETE` grant on this table for any role including `service_role` application code paths — corrections are new offsetting entries, never edits. This is what makes the ledger auditable.

### `pricing_config`

Single-row-per-key config table so pricing changes don't require an app release.

| key                                   | example value | meaning                          |
| ------------------------------------- | ------------- | -------------------------------- |
| `credit_unit_kobo`                    | 1000          | 1 credit = ₦10.00                |
| `message_base_credits`                | 2             | cost per 50-word block           |
| `message_word_block_size`             | 50            | words per block                  |
| `message_max_words`                   | 500           | hard cap enforced client+server  |
| `status_upload_credits_text`          | 3             |                                  |
| `status_upload_credits_media`         | 6             |                                  |
| `platform_topup_fee_bps`              | 200           | 2.00%                            |
| `platform_earning_take_bps`           | 2000          | 20.00%                           |
| `withdrawal_min_kobo`                 | 50000         | ₦500 minimum payout batch        |
| `withdrawal_auto_sweep_hours`         | 24            |                                  |
| `escrow_unanswered_refund_hours`      | 48            | auto-refund A if B never replies |
| `kyc_tier1_daily_withdrawal_cap_kobo` | 5000000       | ₦50,000/day                      |

Read by Edge Functions per-request (cached briefly, e.g. 60s, in-memory) — never hardcoded in app or function code.

### `threads`

| id, participant_a (payer), participant_b (payee), created_at, last_message_at, is_blocked |

### `messages`

| id, thread_id, sender_id, body, word_count, credits_charged, status (`escrowed`/`released`/`refunded`), created_at |

Client has **no INSERT/UPDATE grant** on this table; all writes go through `fn_send_message`.

### `escrows`

Tracks credits charged to A that are held until B responds (see `docs/03-ECONOMY-LEDGER.md` for the full flow).
| id, thread_id, message_id, payer_id, payee_id, credits_held, status (`pending`/`released`/`refunded`), created_at, expires_at |

### `topups`

| id, user_id, amount_kobo_paid, platform_fee_kobo, credits_issued, provider (`flutterwave`/`paystack`), provider_ref, status, created_at |

### `withdrawals`

| id, user_id, amount_kobo, platform_fee_kobo, bank_account_id, provider, provider_ref, status (`pending`/`processing`/`paid`/`failed`/`held_for_review`), triggered_by (`manual`/`auto_sweep`), created_at |

### `bank_accounts`

| id, user_id, provider_account_id, account_number (last 4 only stored raw, rest tokenized by provider), bank_name, account_name, name_match_verified boolean, created_at |

### `kyc_records`

| id, user_id, tier, provider, provider_ref, bvn_or_nin_hash, status, verified_at, expires_at |

### `fraud_signals`

Append-only event log feeding the rules/scoring described in `docs/06-SECURITY-FRAUD-LOOPHOLES.md`: shared device fingerprints between a payer/payee pair, velocity spikes, repeated near-identical message bodies, chargeback history, etc.

### `status_updates`

| id, user_id, media_url, caption, credits_charged, expires_at (24h), created_at |

## 2. Row Level Security posture

- `users`: `SELECT` own row + rows of anyone you share a thread with (limited columns via a view); `UPDATE` own row only, excluding `kyc_tier`/`is_suspended` (service-role only).
- `wallets`, `ledger_entries`, `escrows`, `withdrawals`, `topups`, `kyc_records`: `SELECT` own rows only. **No client `INSERT`/`UPDATE`/`DELETE` grants at all** — every write is via `SECURITY DEFINER` functions invoked by Edge Functions using the service role.
- `messages`, `threads`: `SELECT` if you're a participant; no direct client writes (see above).
- `pricing_config`: readable by `authenticated` (needed for client-side cost preview before sending), writable only by an internal `ops` role via the Supabase Studio / admin tool, and every write is logged to a `pricing_config_history` audit table.

## 3. Locking order (deadlock prevention)

Any function touching more than one wallet locks them in a **fixed global order** (e.g., sort by `wallet_id` ascending, then `SELECT ... FOR UPDATE` in that order) — this applies to `fn_send_message` (locks payer's `topup_credit` + creates escrow) and `fn_release_escrow` (locks escrow, payee's `earnings_pending`, and the platform's own system wallet for its cut). The platform itself has a `wallets` row (`user_id = null`, `kind = 'platform_revenue'`) so platform revenue is trackable through the exact same ledger mechanism — no off-ledger revenue counting.

## 4. Reconciliation job

An hourly `pg_cron` job sums `ledger_entries` per wallet and compares to the cached `wallets.balance`; any mismatch pages on-call and freezes new writes to that wallet (`is_frozen` flag checked by the `SECURITY DEFINER` functions) until an admin clears it. This is the backstop against any bug in the transactional logic above actually costing money silently.
