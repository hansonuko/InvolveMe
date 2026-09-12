# 05 — API & Realtime Spec

All money-affecting endpoints are Supabase **Edge Functions** (Deno/TypeScript), called by the client with the user's JWT, which internally call `SECURITY DEFINER` Postgres RPC functions. Non-money reads/subscriptions go straight through the Supabase client SDK against RLS-protected tables/views.

## 1. Edge Functions

### `POST /functions/v1/send-message`

```jsonc
// Request — either an existing thread_id, or a recipient_id to start one
{ "thread_id": "uuid", "body": "text (max 500 words, enforced server-side)" }
// or, starting a new conversation (no documented "start thread" call otherwise):
{ "recipient_id": "uuid", "body": "text (max 500 words, enforced server-side)" }

// Response 200
{
  "thread_id": "uuid",
  "message_id": "uuid",
  "credits_charged": 4,
  "word_count": 63,
  "status": "escrowed",
  "payer_balance_after": 862
}

// Response 402 (insufficient balance)
{ "error": "insufficient_credit", "credits_required": 4, "credits_available": 1 }
```

Server steps: authenticate → if `thread_id` is missing, validate `recipient_id` (must exist, must not be the caller) and call `fn_start_thread(caller_id, recipient_id)` to find-or-create the thread, with the caller as participant_a/payer → call `fn_send_message(thread_id, sender_id, body)` (word count and `credits_charged` are computed inside the function from `pricing_config`, not passed in) which does the debit + escrow + insert in one transaction → if sender is B replying, the same call also triggers `fn_release_escrow` for pending escrows in that thread.

Error codes: `thread_not_found` (404), `not_a_participant` (403), `thread_blocked` (403), `wallet_frozen` (403), `recipient_not_found` (404, when starting via `recipient_id`), `empty_message` (400), `message_too_long` (400), `insufficient_credit` (402), `invalid_request` (400, e.g. neither `thread_id` nor `recipient_id` given, or `recipient_id` equals the caller).

Response now includes `thread_id` — required so the client can continue the conversation. Once a thread exists, replies **must** pass its `thread_id`, not `recipient_id`: `fn_start_thread(payer, payee)` looks up `(participant_a, participant_b)` as an ordered pair, so the payee replying with `recipient_id` set to the payer would look up (and, finding none, create) a second, reversed-role thread rather than continuing the first — participant_a/payer is fixed for the life of a thread and is always whoever opened it.

### `POST /functions/v1/buy-credit`

```jsonc
// Request
{ "amount_kobo": 100000, "provider": "flutterwave" }
// Response
{ "checkout_url": "https://checkout.flutterwave.com/...", "topup_id": "uuid" }
```

Creates a `topups` row (`status: pending`) and returns the provider's hosted checkout link (never collect card details in-app — offload PCI scope entirely to the PSP). Credits are issued only on confirmed webhook, not on client return-from-checkout (client return can be spoofed/interrupted; webhook is authoritative).

### `POST /functions/v1/webhook-flutterwave` (and future `webhook-paystack`)

Server-to-server only, not called by the app.

- Verify `verif-hash` header against `FLW_WEBHOOK_SECRET_HASH`. Reject (401) on mismatch, no processing.
- Check `provider_event_id` against a `webhook_events_seen` table; if already processed, return 200 immediately without reprocessing (idempotency).
- On confirmed charge: call `fn_confirm_topup(topup_id)` which computes the fee split (§3 of economy doc), issues credits, and marks the `topups` row `completed`.
- On failed/reversed charge: mark `failed`, no credits issued; if credits were already issued and the charge later reverses (chargeback), see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §3 for the clawback path.

### `POST /functions/v1/withdraw`

```jsonc
// Request
{ "bank_account_id": "uuid" }   // amount is implicit: full withdrawable_cash balance, or provide amount_kobo to withdraw partially ≥ withdrawal_min_kobo
// Response 200
{ "withdrawal_id": "uuid", "amount_kobo": 96000, "status": "processing" }
// Response 403 (not eligible)
{ "error": "kyc_required" | "bank_account_unverified" | "below_minimum" | "daily_limit_exceeded" }
```

Requires KYC tier ≥ 1 and a `bank_accounts` row with `name_match_verified = true`. Calls `fn_initiate_withdrawal` → Flutterwave Transfers API → on provider webhook confirmation, marks `paid`.

### `POST /functions/v1/post-status`

```jsonc
{ "media_url": "...", "caption": "optional text" }
```

Debits `status_upload_credits_*` from `topup_credit`, inserts `status_updates` row with `expires_at = now() + 24h`.

### `GET /functions/v1/estimate-message-cost?words=N` (or computed client-side from public `pricing_config` for instant UI feedback — server remains authoritative at actual send time regardless)

### `POST /functions/v1/kyc-callback`

Server-to-server webhook from the KYC vendor confirming BVN/NIN + liveness check result → updates `kyc_records` and `users.kyc_tier`.

## 2. Scheduled jobs (pg_cron → Edge Function)

| Job                    | Schedule     | Does                                                                                                                                                                                                             |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow-expiry-sweep`  | every 15 min | Refunds any `escrows` past `expires_at` still `pending` back to payer                                                                                                                                            |
| `auto-withdraw-sweep`  | hourly       | Finds `withdrawable_cash` funds older than `withdrawal_auto_sweep_hours` per user with a verified bank account and initiates payout; for users without one, sends a reminder push instead (see loopholes doc §5) |
| `reconciliation-check` | hourly       | Sums `ledger_entries` per wallet vs cached `balance`; freezes + pages on mismatch                                                                                                                                |
| `kyc-recheck`          | daily        | Re-validates KYC records nearing `expires_at`                                                                                                                                                                    |
| `dormant-topup-notice` | daily        | Nudges users with unused `topup_credit` sitting idle (product/engagement, not financial)                                                                                                                         |

## 3. Realtime channels (Supabase Realtime)

- `postgres_changes` on `messages` filtered by `thread_id=eq.<id>` — chat delivery.
- `postgres_changes` on `wallets` filtered by `user_id=eq.<self>` — live balance updates driving the motion spec in `docs/04-DESIGN-SYSTEM.md`.
- Presence channel per thread — typing indicators, online status (ephemeral, not persisted).
- Broadcast channel per thread — read receipts (ephemeral by design; if a persisted read-receipt audit trail is ever needed for disputes, add a `message_reads` table deliberately rather than repurposing broadcast).

## 4. Sequence: a full paid exchange

```
A (client)                Edge: send-message         Postgres                    B (client)
   │  "hi" (30 words)  ───────▶ auth+validate ───────▶ fn_send_message:
   │                                                    debit A 2cr, escrow(pending)
   │◀── balance_after: 98 ───────────────────────────────┘
   │                                                                                 │
   │                                              Realtime: new message ────────────▶│ sees "hi", escrow badge shown to A only
   │                                                                                 │
   │                          send-message ◀───────────────────────────────── "hello, how are you" (60 words)
   │                          auth+validate ───▶ fn_send_message:
   │                                              debit A 4cr (new escrow, pending)
   │                                              + fn_release_escrow(first escrow):
   │                                                  2cr → 80%→B.earnings_pending(+1.6→2*), 20%→platform
   │◀── Realtime: wallet update (balance ↓) ─────────────┤
   │                                                      └── Realtime: wallet update (B earnings ↑, gold flash) ──▶│
```

`*` per the rounding rule in `docs/03-ECONOMY-LEDGER.md` §5.

## 5. Error handling conventions

All Edge Functions return a consistent shape on error: `{ "error": "machine_code", "message": "human string" }` with an appropriate 4xx/5xx status. Client maps `machine_code` to localized copy — never displays raw provider (Flutterwave) error text to end users.
