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
{ "amount_kobo": 100000 }
// Response 200
{
  "topup_id": "uuid",
  "amount_kobo_paid": 100000,
  "platform_fee_kobo": 2000,
  "credits_issued": 98,
  "provider": "flutterwave",
  "bank_transfer": {
    "account_number": "9495158721",
    "bank_name": "Flutterwave MFB (Formerly OK MFB)",
    "account_name": null,
    "expires_at": "2026-09-12T19:15:26.000Z"
  }
}
// Response 400
{ "error": "invalid_request" }
// Response 503 (provider unavailable — topup marked failed, nothing charged)
{ "error": "payment_provider_unavailable" }
```

**No checkout URL — this is real, not aspirational, per docs/00-SESSION-HANDOFF.md's session-3 research.** Flutterwave v4 has no single "give me a checkout link" call; the real, live-confirmed path is a one-time NGN bank-transfer virtual account (no card tokenization, no PCI scope in the app, no BVN/NIN needed for this dynamic/one-off kind — see `packages/payments/flutterwave.ts`'s `initiateCollection` comment for exactly which endpoint and why). The client displays `bank_transfer.account_number`/`bank_name` and the amount, same UX shape a checkout-link flow would have had. Creates a `topups` row (`status: pending`); credits are issued only on the confirmed `charge.completed` webhook (`fn_confirm_topup`), never on this call returning 200 — a 200 here means "here's where to send the money," not "payment received."

Card and other payment methods aren't implemented — only NGN bank transfer, matching this project's phone-only, KYC-light v1 scope.

### `POST /functions/v1/webhook-flutterwave` (and future `webhook-paystack`)

Server-to-server only, not called by the app.

- Verify the `flutterwave-signature` header: HMAC-SHA256 of the raw request body against `FLW_WEBHOOK_SECRET_HASH`, **base64** digest, constant-time compared. Reject (401) on missing/mismatched signature, no processing. (Originally documented here as a `verif-hash` direct-string-compare header — that was Flutterwave's older mechanism. Corrected once to HMAC-SHA256/`flutterwave-signature` in Phase 2 batch 2, then corrected again this session on the digest encoding — batch 2's version used `hex`, but Flutterwave's own webhook-docs verification code sample uses `base64`; would have rejected every real webhook. Caught by reading that sample directly, not assumed.)
- Check the webhook's own `id` (not the charge/transfer id) against `webhook_events_seen` (`provider`, `provider_event_id` unique); if already claimed, return 200 immediately without reprocessing. Claimed via upsert-ignore-duplicates — the unique constraint is the actual idempotency guarantee, `fn_confirm_topup`/`fn_complete_withdrawal` are independently idempotent too (defense in depth, not either/or).
- `charge.completed` with `data.reference` = a `topups.id` and `data.status`: `succeeded` → `fn_confirm_topup(topup_id, provider_ref)`. `charge.completed` with any other `data.status` (failed/voided) → the topup row is marked `failed` directly (no balance was ever touched for a `pending` topup, so this doesn't need a `SECURITY DEFINER` function).
- `transfer.disburse` with `data.reference` = a `withdrawals.id` → `fn_complete_withdrawal(withdrawal_id, provider_ref)` (a pure status transition to `paid`, the balance mutation already happened at `fn_initiate_withdrawal` time). Corrected this session from `transfer.completed` — that name was never confirmed against v4's actual docs; the real event name is `transfer.disburse`, per developer.flutterwave.com's own API-overview reference.
- `transfer.reversal` with `data.reference` = a `withdrawals.id` → `fn_fail_withdrawal(withdrawal_id)` (reverses the debit — a transfer can fail asynchronously after our DB already committed it as `processing`). Corrected this session from `transfer.failed`, same reason as above.
- Any other event type (`order.authorization`, `refund.completed`, unrecognized future types): acknowledged (200), no DB action.
- On failed/reversed charge: no credits issued (topup marked `failed`, see above); if credits were already issued and the charge later reverses (chargeback), see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §3 for the clawback path (not built).

Event `type` strings and payload shape (`data.reference`, `data.id`, `data.status`) are Flutterwave's documented v4 webhook convention, confirmed this session against their live docs and a real `charge.completed` sample payload — see `packages/payments/flutterwave.ts`'s header comment for what's confirmed vs. still-assumed (the transfer event names are corrected from a prior guess but not yet seen fired for real).

### `POST /functions/v1/withdraw`

```jsonc
// Request
{ "bank_account_id": "uuid", "amount_kobo": 50000 }   // amount_kobo optional: omit for full withdrawable_cash balance, or provide to withdraw partially ≥ withdrawal_min_kobo
// Response 200
{ "withdrawal_id": "uuid", "amount_kobo": 96000, "status": "processing" }
// Response 403 (not eligible)
{ "error": "kyc_required" | "bank_account_unverified" | "below_minimum" | "daily_limit_exceeded" }
// Response 400
{ "error": "invalid_request" | "invalid_amount" }
// Response 503 (provider unavailable — balance not debited)
{ "error": "payment_provider_unavailable" }
```

Requires KYC tier ≥ 1 and a `bank_accounts` row with `name_match_verified = true` **and** a non-null `provider_account_id` (checked by the Edge Function before ever calling `fn_initiate_withdrawal`, so an unlinked-but-KYC'd account fails fast rather than debit-then-immediately-reverse). Calls `fn_initiate_withdrawal` (debits `withdrawable_cash` immediately, status `processing`) → `PaymentProvider.initiatePayout({ recipientId: bank_accounts.provider_account_id, ... })` → on provider failure, calls `fn_fail_withdrawal` so the debit doesn't strand, and returns 503 rather than a false `processing`. On provider webhook confirmation (`transfer.disburse`/`transfer.reversal`, see webhook-flutterwave above), marks `paid` or reverses.

`PaymentProvider.initiatePayout` calls the real live Flutterwave `/transfers` endpoint (see `packages/payments/flutterwave.ts`) — confirmed this session by actually calling it: a transfer to a deliberately-fake recipient id came back a real `RECIPIENT_NOT_FOUND` (404), proving the request shape and auth are correct end-to-end up to that point. **Bank-account linking (the flow that would populate a real `bank_accounts.provider_account_id` for a real user via `/transfers/recipients`) still isn't built** — every `bank_accounts` row usable by `withdraw` today is a manually-inserted test fixture, so no withdrawal has actually completed for real yet. That's the next real gap on the payout side, not the provider call itself.

### `POST /functions/v1/post-status`

```jsonc
// Request — at least one of media_url/caption required
{ "media_url": "optional url", "caption": "optional text" }

// Response 200
{ "status_id": "uuid", "credits_charged": 6, "payer_balance_after": 92 }

// Response 400
{ "error": "empty_status" | "invalid_request" }
// Response 402 (insufficient balance — same shape as send-message)
{ "error": "insufficient_credit", "credits_required": 6, "credits_available": 2 }
// Response 403
{ "error": "wallet_frozen" }
```

Debits `status_upload_credits_media` if `media_url` is present, else `status_upload_credits_text`, from `topup_credit` — no escrow, no earning (see `docs/03-ECONOMY-LEDGER.md` §7). Inserts a `status_updates` row with `expires_at = now() + 24h`. All billing/validation happens inside `fn_post_status`, called by the `post-status` Edge Function (built — see `docs/00-SESSION-HANDOFF.md`); the client's request never carries a computed credit amount.

### `POST /functions/v1/find-user-by-phone`

```jsonc
// Request
{ "phone": "+2348012345678" }
// Response 200
{ "id": "uuid", "display_name": "string | null", "avatar_url": "string | null" }
// Response 400
{ "error": "invalid_request" } // missing phone, or looking up your own number
// Response 404
{ "error": "user_not_found" }
```

Added this session — a real gap found wiring up the mobile "start a new chat" flow: `send-message` takes a `recipient_id` (uuid), but nothing resolved a phone number to one, and direct client reads can't fill this (`users_select_own_or_thread_partner`, per the RLS migration, correctly only exposes your own row or an existing thread partner's, not an arbitrary stranger's). This is a narrow, purpose-built lookup — returns only `id`/`display_name`/`avatar_url`, never the phone number back, no financial logic, done via the service-role client the same way any other Edge Function's non-money reads are. **Known gap:** no rate limiting beyond whatever Supabase applies platform-wide, so this is a phone-enumeration surface if automated — not addressed here, not called out in `docs/06-SECURITY-FRAUD-LOOPHOLES.md` either; worth adding if it becomes a real problem.

Client input must be E.164 **with** a leading `+` (matching what's used for `signInWithOtp`) — the function strips it before comparing, since `users.phone` itself is stored without one (see `docs/02-DATA-MODEL.md`'s note on this — found by testing, not by reading the schema comment, which had said plain "E.164").

### `GET /functions/v1/estimate-message-cost?words=N` (or computed client-side from public `pricing_config` for instant UI feedback — server remains authoritative at actual send time regardless)

### `POST /functions/v1/submit-kyc`

```jsonc
// Request
{ "type": "bvn", "number": "22362591439" }   // or "type": "nin"
// Response 200
{ "verified": true, "tier": 1 }
// Response 400
{ "error": "invalid_request" }             // wrong type, or number isn't exactly 11 digits
// Response 422
{ "error": "verification_failed", "message": "We couldn't verify that number." }
// Response 503
{ "error": "kyc_provider_unavailable" }
```

Tier 1 only — plain BVN/NIN number verification via Prembly's BVN/NIN Basic REST API, synchronous (no webhook/callback needed, unlike the original `kyc-callback` design below assumed). No camera/liveness capture; Prembly's separate `react-native-identity-kyc` widget (Tier 2) is deliberately not used — see `docs/00-SESSION-HANDOFF.md`. The raw BVN/NIN is never persisted (hashed with a server-only pepper before it touches `kyc_records`) and never returned to the client. A watchlist match (screened as part of this same call, per `docs/07-COMPLIANCE-LEGAL.md` §2) returns the identical `verification_failed` response as a not-found number — deliberately indistinguishable to the caller — and is logged to `fraud_signals` instead.

**Every call costs Prembly real money (~₦45), success or failure** — confirmed live, not documented anywhere in Prembly's own docs excerpt read while building this.

### `POST /functions/v1/link-bank-account`

```jsonc
// Request
{ "bank_code": "044", "bank_name": "Access Bank", "account_number": "0690000031" }
// Response 200
{ "bank_account_id": "uuid", "bank_name": "Access Bank", "account_name": "JOHN DOE", "account_number_last4": "0031" }
// Response 400
{ "error": "invalid_request" | "invalid_account" }   // invalid_account = a real rejection from Flutterwave's account-resolve, e.g. account doesn't exist
// Response 403
{ "error": "kyc_required" }
// Response 422
{ "error": "name_mismatch" }
// Response 503
{ "error": "payment_provider_unavailable" }
```

Requires KYC tier ≥ 1 (`submit-kyc`). Resolves the account's registered name via Flutterwave (`/banks/account-resolve`), name-matches it against the caller's KYC-verified identity (order-independent token match — Nigerian BVN records and bank names don't agree on name order), and only on a match creates a real Flutterwave transfer recipient (`/transfers/recipients`) and writes `bank_accounts` with `name_match_verified: true`. A mismatch is a hard rejection — no row inserted, no way to "fix later" via this endpoint — per CLAUDE.md rule #7. This is what actually populates `bank_accounts.provider_account_id` for a real user; `withdraw`'s own checks were always correct, there was just never a way to satisfy them until this function existed.

### `GET /functions/v1/list-banks`

```jsonc
// Response 200
{ "banks": [{ "code": "044", "name": "Access Bank" }, ...] }
```

Read-only proxy for Flutterwave's `/banks?country=NG`, for the bank-picker UI — not hardcoded, since Flutterwave is the source of truth for which `bank_code` values the two functions above will actually accept.

### `POST /functions/v1/transfer-credit`

```jsonc
// Request
{ "recipient_phone": "+2348012345678", "credits": 50, "note": "for lunch" }   // note optional
// Response 200
{ "transfer_id": "uuid", "credits_sent": 50, "platform_cut_credits": 10, "credits_received": 40 }
// Response 400
{ "error": "invalid_request" | "invalid_amount" | "amount_over_transfer_cap" }
// Response 402
{ "error": "insufficient_credit" }
// Response 403
{ "error": "sender_suspended" | "recipient_suspended" | "wallet_frozen" }
// Response 404
{ "error": "user_not_found" }
```

Peer-to-peer chat-credit transfer, convertible to cash on the recipient's side — see `docs/03-ECONOMY-LEDGER.md` §9 and `docs/07-COMPLIANCE-LEGAL.md` §1 (this is the one feature that document names explicitly as needing a legal check before shipping; it shipped anyway, flagged). `recipient_phone` resolves the same way `find-user-by-phone` does. `credit_transfer_max_credits` in `pricing_config` caps a single call.

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
- `postgres_changes` on `topups` filtered by `id=eq.<topup_id>` — lets the buy-credit screen detect a transfer clearing without the user backing out to check manually.
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
