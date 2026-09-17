# 05 — API & Realtime Spec

All money-affecting endpoints are Supabase **Edge Functions** (Deno/TypeScript), called by the client with the user's JWT, which internally call `SECURITY DEFINER` Postgres RPC functions. Non-money reads/subscriptions go straight through the Supabase client SDK against RLS-protected tables/views.

## 1. Edge Functions

### `POST /functions/v1/send-message`

```jsonc
// Request — either an existing thread_id, or a recipient_id to start one
{ "thread_id": "uuid", "body": "text (max 500 words, enforced server-side)" }
// or, starting a new conversation (see start-thread below for creating an
// empty thread without sending a message at the same time):
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

**Push notification side effect (added 2026-09-14):** after a successful send, the recipient gets a best-effort Expo push notification (`_shared/push.ts`'s `sendPushToUser`, fired via `EdgeRuntime.waitUntil` so it can never delay or fail this response) with the sender's `display_name` as title and a truncated message preview as body. Silently a no-op if the recipient has no row in `push_tokens` (no dedicated notification-preference flag exists — see that table's note in `docs/02-DATA-MODEL.md`).

### `POST /functions/v1/start-thread`

```jsonc
// Request
{ "recipient_id": "uuid" }
// Response 200
{ "thread_id": "uuid" }
// Response 400
{ "error": "invalid_request" }          // missing recipient_id
{ "error": "cannot_thread_with_self" }
```

Added Phase 6 (docs/10-UX-REFINEMENT-BACKLOG.md Batch B) — resolves/creates a thread with another user without sending a message, for "tap a found user in the new-chat flow, go straight into their chat" instead of forcing a first message through `send-message`. A thin wrapper around `fn_start_thread` (the same function `send-message`'s own `recipient_id` path already calls internally) — idempotent, no financial logic. The caller is always participant_a/payer for a brand-new thread, same rule `send-message` documents above.

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

### `POST /functions/v1/check-topup-status`

```jsonc
// Request
{ "topup_id": "uuid" }
// Response 200
{ "status": "pending" | "completed" | "failed" }
// Response 403 (topup belongs to another user)
{ "error": "not_your_topup" }
```

Added 2026-09-14 (session 12, continued) after real-device testing showed the "credits land automatically" promise on the buy-credit screen wasn't actually fast — the webhook that promise depended on has never once fired in this app's history (see `webhook-flutterwave`'s entry below), and `reconcile-topups`' cron only checks topups older than 5 minutes, every 10 minutes. This is the same Flutterwave ground-truth check (`PaymentProvider.checkCollectionStatus`), called on demand for one specific topup with no age gate, self-confirming via `fn_confirm_topup` exactly like the cron does — the mobile client polls it every ~4s while the payment screen is open and still pending, so the "instant" feeling comes from the client asking often while the user is actually watching, not from the provider ever pushing anything reliably. Ownership-checked (`topups.user_id === caller.id`), unlike `reconcile-topups`' machine-only all-users sweep, since this has a real per-user caller a client could otherwise abuse to probe other users' payments.

### `POST /functions/v1/webhook-flutterwave` (and future `webhook-paystack`)

Server-to-server only, not called by the app.

**This section was wrong twice before this correction, and the second wrongness is the actual reason a real user's top-up credit didn't land for a recurring, not one-off, incident on 2026-09-13 — see `docs/00-SESSION-HANDOFF.md`'s top section and `packages/payments/flutterwave.ts`'s header comment for the full story.** What follows is re-verified against developer.flutterwave.com/docs/webhooks and .../reference/webhooks, fetched fresh and independently (twice, agreeing), not carried forward from a previous session's confidence:

- Verify the **`verif-hash`** header: a **plain string comparison** (constant-time) against `FLW_WEBHOOK_SECRET_HASH` — no HMAC, no digest, nothing computed over the body. (Batch 2 originally documented `verif-hash`/direct-compare correctly, then a later session "corrected" it to a `flutterwave-signature`/HMAC-SHA256/base64 scheme that Flutterwave does not actually implement — that version shipped, was deployed, and silently rejected every real webhook for weeks, undetected because the only regression test signed its own synthetic requests with the same wrong scheme it was testing. This is now corrected back, this time against directly-fetched current docs rather than memory.)
- The envelope is `{ event, data }`, **not** `{ type, data }`. There is no top-level delivery/event id — `webhook_events_seen.provider_event_id` is synthesized as `` `${event}:${data.id}` `` instead.
- `charge.completed` with `data.tx_ref` = a `topups.id` and `data.status` (lowercase) `successful` → `fn_confirm_topup(topup_id, provider_ref)`. Any other `data.status` (`failed`, etc.) → the topup row is marked `failed` directly (no balance was ever touched for a `pending` topup, so this doesn't need a `SECURITY DEFINER` function). Charges use `tx_ref`, not `reference`, for the merchant reference — confirmed against a real documented example payload.
- `transfer.completed` with `data.reference` = a `withdrawals.id` (transfers use `reference`, not `tx_ref` — the two resource types don't share a convention) and `data.status` (uppercase) `SUCCESSFUL` → `fn_complete_withdrawal(withdrawal_id, provider_ref)`; `FAILED` → `fn_fail_withdrawal(withdrawal_id)`. There is exactly **one** transfer completion event name — a prior session's guess of two separate `transfer.disburse`/`transfer.reversal` events was never confirmed against a real transfer payload (no real payout has disbursed from this app yet) and turned out wrong; outcome is read from `data.status`, not the event name.
- Any other event type, or a recognized event missing its expected reference field: acknowledged (200), no DB action, but the latter case is logged loudly (`console.error`) specifically because "recognized event, unexpected shape" is exactly the failure class this incident already had once.
- On failed/reversed charge: no credits issued (topup marked `failed`, see above); if credits were already issued and the charge later reverses (chargeback), see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §3 for the clawback path (not built).

**Ground-truth check performed before shipping this correction** (not just re-reading docs): queried `webhook_events_seen` directly against the dev DB — 0 rows, ever — then cross-checked Flutterwave's own `GET /charges?customer_id=...` and found two real ₦100 charges made the same day, both `status: "succeeded"`, both still stuck as `pending` topups in this DB. That's what proved the bug was live, not just theoretically possible from a doc re-read.

**Push notification side effects (added docs/10-UX-REFINEMENT-BACKLOG.md Batch G):** a successful `fn_confirm_topup` here (or via `reconcile-topups`/`check-topup-status`, which hit the exact same shared helper — `notifyTopupConfirmed` in `_shared/push.ts`) pushes the payer "Credit purchased" / "N credits have landed in your wallet". A successful `fn_complete_withdrawal` pushes the withdrawing user "Withdrawal sent" / "₦X has been sent to your bank account" (`notifyWithdrawalCompleted`). Both best-effort, fired via `runInBackground` so a slow/failed push provider call never delays this webhook's own 200 to Flutterwave.

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

Requires KYC tier ≥ 1 and a `bank_accounts` row with `name_match_verified = true` **and** a non-null `provider_account_id` (checked by the Edge Function before ever calling `fn_initiate_withdrawal`, so an unlinked-but-KYC'd account fails fast rather than debit-then-immediately-reverse). Calls `fn_initiate_withdrawal` (debits `withdrawable_cash` immediately, status `processing`) → `PaymentProvider.initiatePayout({ recipientId: bank_accounts.provider_account_id, ... })` → on provider failure, calls `fn_fail_withdrawal` so the debit doesn't strand, and returns 503 rather than a false `processing`. On provider webhook confirmation (`transfer.completed`, see webhook-flutterwave above), marks `paid` or reverses.

`PaymentProvider.initiatePayout` calls the real live Flutterwave `/transfers` endpoint (see `packages/payments/flutterwave.ts`) — confirmed this session by actually calling it: a transfer to a deliberately-fake recipient id came back a real `RECIPIENT_NOT_FOUND` (404), proving the request shape and auth are correct end-to-end up to that point. **Bank-account linking (the flow that would populate a real `bank_accounts.provider_account_id` for a real user via `/transfers/recipients`) still isn't built** — every `bank_accounts` row usable by `withdraw` today is a manually-inserted test fixture, so no withdrawal has actually completed for real yet. That's the next real gap on the payout side, not the provider call itself.

### `GET /functions/v1/get-withdrawal-countdown`

```jsonc
// Response 200
{ "effective_sweep_hours": 24, "force_sweep_below_minimum": true }
```

Added Phase 6 (`20260916091500_fn_get_withdrawal_countdown.sql`) — lets the wallet tab render a real countdown ring for the caller's own `withdrawable_cash` auto-sweep, instead of inventing one. `effective_sweep_hours` is `withdrawal_auto_sweep_hours` (24, normal) or `withdrawal_auto_sweep_hours_untrusted` (72, per `20260915160000_settlement_aware_auto_sweep.sql`'s trust gate) depending on the caller's own `fn_is_withdrawal_trusted` result — never returned directly, since this app has no self-serve dispute/unfreeze path and a raw "you are untrusted" field would leak more than a ring needs. `force_sweep_below_minimum` is the one bit of that distinction actually needed client-side: whether a below-`withdrawal_min_kobo` balance will still force-sweep eventually (`true`, trusted) or is held indefinitely until it either clears the minimum or the account ages/clears into trusted (`false`, untrusted) — communicates the effect, not the diagnosis. Doesn't return `wallet.updated_at`, `withdrawal_min_kobo`, or `withdrawal_force_sweep_days` — all three are already directly client-readable (`wallets` row-level RLS; `pricing_config` is fully authenticated-readable).

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

### `POST /functions/v1/register-device-fingerprint`

```jsonc
// Request
{ "fingerprint_hash": "64-char hex SHA-256 digest, hashed on-device" }
// Response 200
{ "ok": true }
// Response 400
{ "error": "invalid_request" } // missing/malformed hash — must be 64 hex chars
```

Added 2026-09-15 (session 13, `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §2). Called once per app session (`apps/mobile/app/_layout.tsx`, same automatic/silent pattern as the push-token resync) — never sees a raw hardware identifier, only its SHA-256, hashed client-side by `expo-crypto` before the request is made. No user-visible effect either way; purely feeds `fn_run_collusion_detection`.

### `POST /functions/v1/mark-thread-read`

```jsonc
// Request
{ "thread_id": "uuid" }
// Response 200
{ "ok": true }
// Response 400
{ "error": "invalid_request" } // missing thread_id
// Response 403
{ "error": "not_a_participant" }
// Response 404
{ "error": "thread_not_found" }
```

Added 2026-09-14 alongside the read-cursor migration (`20260914080000_thread_read_cursor.sql`). Sets the caller's own `participant_a_last_read_at`/`participant_b_last_read_at` column to `now()` via `fn_mark_thread_read` — no financial logic, but same "identity re-derived from the JWT, never trusted from the body" posture as every other function here. Called on opening a thread (see `apps/mobile/app/thread/[id].tsx`). The unread count itself isn't returned by this endpoint or any other — clients read `public.thread_unread_counts` (a `security_invoker` view, RLS-equivalent scoping via `auth.uid()`) directly, same as any other read that doesn't need server-side computation.

### `POST /functions/v1/set-thread-blocked`

```jsonc
// Request
{ "thread_id": "uuid", "blocked": true }
// Response 200
{ "ok": true, "blocked": true }
// Response 400
{ "error": "invalid_request" } // missing thread_id, or blocked isn't a boolean
// Response 403
{ "error": "not_a_participant" }
{ "error": "not_the_blocker" } // trying to unblock a thread someone *else* blocked
// Response 404
{ "error": "thread_not_found" }
```

Added 2026-09-14 (`20260914090000_settings_privacy_reports_push.sql`) — the actual write path for blocking. `threads.blocked_by` and its enforcement inside `fn_send_message` (rejects any send while non-null, with `thread_blocked`) both existed before this; nothing ever set it until this function. Idempotent both directions: blocking an already-blocked thread is a no-op success (doesn't overwrite who blocked it first); unblocking an already-unblocked thread is a no-op success. Only the user recorded in `blocked_by` can unblock — a blocked person can't unilaterally clear it themselves. Called from the thread screen's own overflow menu and from Settings > Privacy > Blocked contacts (unblock only).

### `POST /functions/v1/set-thread-muted`

```jsonc
// Request
{ "thread_id": "uuid", "muted": true }
// Response 200
{ "ok": true, "muted": true }
// Response 400
{ "error": "invalid_request" } // missing thread_id, or muted isn't a boolean
// Response 403
{ "error": "not_a_participant" }
// Response 404
{ "error": "thread_not_found" }
```

Added 2026-09-17 (`20260917110000_thread_mute.sql`), Batch G part 2. Sets the caller's own `threads.muted_by_a`/`muted_by_b` flag via `fn_set_thread_muted` — unlike blocking, either participant can mute/unmute independently with no "who set it first" precedence, so there's no `not_the_blocker`-style rejection. `send-message`'s push-notification block checks the recipient's own mute flag before calling `sendPushToUser` and silently skips the push (never the message send itself) when muted. Called from the thread screen's own overflow menu.

### `POST /functions/v1/mark-status-viewed`

```jsonc
// Request
{ "status_id": "uuid" }
// Response 200
{ "ok": true }
// Response 400
{ "error": "invalid_request" } // missing status_id
// Response 403
{ "error": "not_visible" } // caller has no non-blocked thread with the poster
// Response 404
{ "error": "status_not_found" }
```

Added Phase 6 (`20260916090000_status_visibility_and_view_tracking.sql`) — records that the caller has seen a status update, driving the unseen(gold)/seen(grey) ring distinction on the mobile status feed. Re-checks the same visibility condition the `status_updates_select_visible_to_thread_partner` RLS policy enforces (a `SECURITY DEFINER` function bypasses RLS, so this has to be explicit rather than relied on implicitly) — a status is visible to, and viewable by, anyone with a non-blocked `threads` row with the poster. The poster marking their own status is a no-op 200, not an error. Idempotent (`on conflict do nothing` on `status_views`'s `(status_id, viewer_id)` primary key).

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

**Push notification side effect (added docs/10-UX-REFINEMENT-BACKLOG.md Batch G):** on success, the recipient gets a best-effort push (sender's `display_name`, or "Someone" if unset, as title; "Sent you N credits" as body) — same `sendPushToUser`/`runInBackground` pattern `send-message` already established.

## 2. Scheduled jobs (pg_cron)

Despite this section's heading, `escrow-expiry-sweep`/`auto-withdraw-sweep`/`reconciliation-check` are pg_cron calling a plpgsql `SECURITY DEFINER` function directly (`select public.fn_...()`) — no Edge Function or network hop involved, per `20260912081331_wire_scheduled_jobs.sql`. `reconcile-topups` (added 2026-09-14, session 12) is the first job that's actually `pg_cron → Edge Function`, because it needs a real HTTPS call out to Flutterwave that plpgsql can't reasonably make itself — routed via `pg_net.http_post`, authenticated with a `supabase_vault`-stored secret (see `20260914120000_reconcile_topups_cron.sql`'s header comment for why Vault and not a plain `app.settings.*` GUC — hosted Supabase's `postgres` role isn't superuser).

| Job                    | Schedule        | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `escrow-expiry-sweep`  | every 15 min    | Refunds any `escrows` past `expires_at` still `pending` back to payer                                                                                                                                                                                                                                                                                                                                                                                   |
| `auto-withdraw-sweep`  | hourly          | Finds `withdrawable_cash` funds older than `withdrawal_auto_sweep_hours` per user with a verified bank account and initiates payout; for users without one, sends a reminder push instead (see loopholes doc §5)                                                                                                                                                                                                                                        |
| `reconciliation-check` | hourly          | Sums `ledger_entries` per wallet vs cached `balance`; freezes + pages on mismatch                                                                                                                                                                                                                                                                                                                                                                       |
| `reconcile-topups`     | every 10 min    | Pull-based safety net for `buy-credit`: any `topups` row still `pending` after 5 min gets checked directly against Flutterwave's `/charges` and self-confirmed if it actually succeeded — doesn't wait on/trust the webhook. See `docs/00-SESSION-HANDOFF.md` session 12 for why this exists: `webhook-flutterwave` had never once received a real Flutterwave-initiated event, despite two earlier "permanent" fixes to its own contract-parsing code. |
| `collusion-detection`  | nightly (03:00) | Two signal types into `fraud_signals` — shared device fingerprint + real paid activity between a pair (high severity), and one payee dominating a payer's weekly message volume (medium severity). Manual-review-only, never auto-freezes. See `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §2 and `docs/00-SESSION-HANDOFF.md` session 13.                                                                                                                    |
| `kyc-recheck`          | daily           | Re-validates KYC records nearing `expires_at` — **not built yet**                                                                                                                                                                                                                                                                                                                                                                                       |
| `dormant-topup-notice` | daily           | Nudges users with unused `topup_credit` sitting idle (product/engagement, not financial) — **not built yet**                                                                                                                                                                                                                                                                                                                                            |

## 3. Realtime channels (Supabase Realtime)

- `postgres_changes` on `messages` filtered by `thread_id=eq.<id>` — chat delivery.
- `postgres_changes` on `wallets` filtered by `user_id=eq.<self>` — live balance updates driving the motion spec in `docs/04-DESIGN-SYSTEM.md`.
- `postgres_changes` on `topups` filtered by `id=eq.<topup_id>` — lets the buy-credit screen detect a transfer clearing without the user backing out to check manually.
- Presence channel per thread — typing indicators (still not built; online status below took a different path).
- **Online/last-seen — built differently than originally spec'd here** (docs/10-UX-REFINEMENT-BACKLOG.md Batch B, `20260917100000_last_seen.sql`): not a Presence channel — a plain `users.last_seen_at` timestamp, updated by the client on a heartbeat, kept live for an open thread via a `postgres_changes` subscription on `users` (same shape as `useThreadMessages`/`useWallets`). "Online" is derived client-side (within ~45s of that timestamp) rather than a separate ephemeral state — avoids a second Realtime primitive's join/leave lifecycle for something that only needs to be this coarse. Gated by `users.last_seen_enabled` (default on), same privacy-toggle posture as `read_receipts_enabled`.
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
