# 02 — Data Model

All monetary/credit columns are `bigint`. Kobo for NGN cash, whole credits for chat credit. Never `numeric`/`float` for either.

## 1. Core tables

### `users` (extends Supabase `auth.users`)

| Column                 | Type        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                     | uuid PK     | = `auth.users.id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| phone                  | text unique | E.164 digits, **without** the leading `+` (confirmed live: Supabase Auth strips it before this trigger-copied value ever lands here) — primary identity (OTP auth, WhatsApp-style). Any code comparing against this column (e.g. `find-user-by-phone`) must strip a leading `+` from client input first, or every lookup silently 404s.                                                                                                                                                                                                                 |
| display_name           | text        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| avatar_url             | text        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| kyc_tier               | smallint    | 0 = unverified, 1 = BVN/NIN verified, 2 = enhanced (liveness) — see `docs/07-COMPLIANCE-LEGAL.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| status_text            | text        | "About" line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| is_suspended           | boolean     | fraud/ops kill-switch, see `docs/06-SECURITY-FRAUD-LOOPHOLES.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| created_at             | timestamptz |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| device_fingerprint_ids | uuid[]      | linked device fingerprints, used for multi-account collusion detection. Existed since the first schema migration but sat completely unused (no table, no writer, no mobile capture) until `20260915090000_device_fingerprinting.sql` — see `device_fingerprints` below. Excluded from the client's `UPDATE` grant same as `kyc_tier`/`is_suspended`; only `fn_link_device_fingerprint` (`SECURITY DEFINER`) writes it.                                                                                                                                  |
| read_receipts_enabled  | boolean     | default `true` — added `20260914090000_settings_privacy_reports_push.sql`. Turning this off doesn't stop the underlying read cursor (`threads.*_last_read_at`) from being written — the owner's own unread-badge accuracy shouldn't depend on whether they share it with others — it stops other participants' clients from _rendering_ a read indicator. Client-updatable via the same RLS grant as `display_name`/`status_text`.                                                                                                                      |
| last_seen_at           | timestamptz | added `20260917100000_last_seen.sql` (docs/10-UX-REFINEMENT-BACKLOG.md Batch B). Updated by the client itself on a heartbeat (`apps/mobile/lib/lastSeen.ts` — on every foreground transition, plus every 30s while actively foregrounded), not a `SECURITY DEFINER` function — self-scoped, no fraud value in misrepresenting your own last-seen timestamp. "Online" is derived client-side (within the last 45s of this value), not a separate stored boolean — deliberately not a Realtime Presence channel; see the migration's own comment for why. |
| last_seen_enabled      | boolean     | default `true`, same client-writable-grant and "gate at read time, don't stop writing it" posture as `read_receipts_enabled` — turning it off hides "online"/"last seen" from thread partners without stopping the heartbeat itself.                                                                                                                                                                                                                                                                                                                    |

### `wallets`

One row per user per balance type — modeled as separate rows, not separate columns, so the ledger-conservation invariant is uniform.

| Column     | Type            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id         | uuid PK         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| user_id    | uuid FK → users |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| kind       | text            | Per-user: `'topup_credit'` (spendable, bought with cash) · `'earnings_pending'` (credits earned, not yet cash-converted) · `'withdrawable_cash'` (kobo, converted & fee-taken, awaiting bank payout). Platform-owned (`user_id is null`): `'platform_revenue_topup_fees'` (kobo) · `'platform_revenue_earnings_cut'` (credits) — spendable revenue; `'platform_reserve_topup_fees'` (kobo) · `'platform_reserve_earnings_cut'` (credits) — the chargeback self-insurance buffer, added `20260915150000_platform_reserve_buffer.sql`, see §5 below |
| balance    | bigint          | **derived/cached** — must always equal `sum(ledger_entries.amount)` for this wallet; reconciliation job checks this hourly                                                                                                                                                                                                                                                                                                                                                                                                                        |
| updated_at | timestamptz     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Unique constraint on `(user_id, kind)`.

### `ledger_entries` (append-only, source of truth)

| Column            | Type              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                | uuid PK           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| wallet_id         | uuid FK → wallets |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| amount            | bigint            | signed; positive = credit, negative = debit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| reason            | text              | enum-like: `topup_purchase`, `topup_platform_fee`, `message_debit`, `escrow_hold`, `escrow_release_earning`, `escrow_release_platform_cut`, `escrow_refund_unanswered`, `earnings_conversion`, `withdrawal_platform_fee`, `withdrawal_payout`, `withdrawal_refund_failed`, `status_upload_debit`, `manual_adjustment`, `credit_transfer_sent`, `credit_transfer_received`, `credit_transfer_conversion`, `credit_transfer_platform_cut`, `group_message_debit`, `group_message_owner_earning`, `group_message_platform_cut`, `platform_reserve_skim`, `chargeback_debit`, `chargeback_fee_reversal` |
| ref_type / ref_id | text / uuid       | polymorphic pointer to the `messages`, `topups`, `withdrawals`, or `escrows` row that caused this entry                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| created_at        | timestamptz       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| created_by        | text              | `'system'` or an admin user id, for `manual_adjustment` rows only — every manual adjustment requires a second admin's sign-off, see below                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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

| id, participant_a (payer), participant_b (payee), created_at, last_message_at, blocked_by, muted_by_a, muted_by_b, participant_a_last_read_at, participant_b_last_read_at |

`blocked_by` (nullable uuid → `users.id`, replaces the earlier plain `is_blocked` boolean as of `20260914090000_settings_privacy_reports_push.sql`) records _who_ blocked the thread — a boolean alone can't say whether the blocker was you or the other participant, which a "Blocked contacts" list and the "only the blocker can unblock" rule both need. Written only by `fn_set_thread_blocked` (`SECURITY DEFINER`, via `set-thread-blocked`); `fn_send_message` rejects any send while it's non-null.

`muted_by_a`/`muted_by_b` (booleans, default `false`, added `20260917110000_thread_mute.sql`) are each participant's own notification-mute flag — modeled as two independent columns rather than a single nullable "who muted" field like `blocked_by`, because mute has no shared precedence to track: either or both participants may mute independently, with no "only the muter can unmute" rule. Written only by `fn_set_thread_muted` (`SECURITY DEFINER`, via `set-thread-muted`), checked by `send-message`'s push-notification block before calling `sendPushToUser` — muting never affects delivery of the message itself, only the push.

The two `*_last_read_at` columns (added `20260914080000_thread_read_cursor.sql`) are each participant's own read cursor — `null` means "never read," not "read at the epoch." Written only by `fn_mark_thread_read` (`SECURITY DEFINER`, called via `mark-thread-read`), which sets the caller's own column after checking which participant they actually are — not a client-writable RLS+column-grant setup, since Postgres column grants can't be conditioned on which participant slot the caller occupies (see the migration's header comment for why that specific shortcut was rejected). `thread_unread_counts` (a `security_invoker` view over `threads`/`messages`) derives each of the caller's threads' unread count from this cursor — messages from the _other_ participant sent after it. No unread state is stored redundantly; it's computed at read time from the cursor + `messages`, same "balance is derived, don't cache it as a separate mutable fact" spirit CLAUDE.md applies to wallets, applied here to unread counts instead of money.

### `messages`

| id, thread_id, sender_id, body, word_count, credits_charged, status (`escrowed`/`released`/`refunded`), created_at |

Client has **no INSERT/UPDATE grant** on this table; all writes go through `fn_send_message`.

### `escrows`

Tracks credits charged to A that are held until B responds (see `docs/03-ECONOMY-LEDGER.md` for the full flow).
| id, thread_id, message_id, payer_id, payee_id, credits_held, status (`pending`/`released`/`refunded`), created_at, expires_at |

### `topups`

| id, user_id, amount_kobo_paid, platform_fee_kobo, credits_issued, provider (`flutterwave`/`paystack`), provider_ref, status (`pending`/`completed`/`failed`/`reversed`), created_at |

`'reversed'` (added `20260915151500_chargeback_clawback.sql`) is set by `fn_process_chargeback` — see §5 below.

### `withdrawals`

| id, user_id, amount_kobo, platform_fee_kobo, bank_account_id, provider, provider_ref, status (`pending`/`processing`/`paid`/`failed`/`held_for_review`), triggered_by (`manual`/`auto_sweep`), created_at |

### `bank_accounts`

| id, user_id, provider_account_id, account_number (last 4 only stored raw, rest tokenized by provider), bank_name, account_name, name_match_verified boolean, created_at |

### `kyc_records`

| id, user_id, tier, provider, provider_ref, bvn_or_nin_hash, status, verified_at, expires_at, verified_first_name, verified_middle_name, verified_last_name |

The three `verified_*_name` columns (added when `submit-kyc` was built) are set only when `status = 'verified'` — used by `link-bank-account` to name-match a bank account against the KYC identity. A legal name is materially less sensitive than the raw BVN/NIN itself (which never gets stored — only `bvn_or_nin_hash`, a peppered one-way hash) and is exactly the retention this table's one compliance function requires.

### `fraud_signals`

Append-only event log feeding the rules/scoring described in `docs/06-SECURITY-FRAUD-LOOPHOLES.md`: shared device fingerprints between a payer/payee pair, velocity spikes, repeated near-identical message bodies, chargeback history, etc. **Populated for real since 2026-09-15** by `fn_run_collusion_detection` (nightly `pg_cron`) — `signal_type` values in active use today are `shared_device_fingerprint` (high severity) and `concentrated_pairing` (medium). Purely additive: nothing reads this table to automatically act on it — `is_frozen` is a separate, manually-set flag, by explicit product decision (no admin UI beyond Supabase Studio exists to safely automate a wallet freeze on a false positive). No `resolved`/status column exists yet, a real limitation, not an oversight — idempotency against re-flagging the same pair is judged by row existence (permanent-condition signals) or a rolling time window (behavioral signals), documented in the migration itself.

### `device_fingerprints` (added `20260915090000_device_fingerprinting.sql`)

| id, fingerprint_hash (unique), first_seen_at |

Backs `users.device_fingerprint_ids` (see below) — a hash gets its own row, rather than living only inside each user's array, because two different users' arrays containing the same id _is_ the signal `fn_run_collusion_detection` looks for. Written only by `fn_link_device_fingerprint` (`SECURITY DEFINER`), called from `register-device-fingerprint` on every app session (`apps/mobile/lib/deviceFingerprint.ts`) — the mobile app hashes a platform device identifier (Android ID / iOS vendor ID) with `expo-crypto` before it ever leaves the device, same "hash before it reaches the server" posture `KYC_HASH_PEPPER` already establishes for BVN/NIN. No RLS policy (enabled, zero policies) — never queried by the client, only written via the function above and read by the collusion job.

### `moderated_content` (added `20260915140000_content_moderation.sql`)

| id, user_id, content_type (`message`\|`status`), ref_id (nullable), action (`blocked`\|`flagged`), categories (jsonb), created_at |

Not `fraud_signals` — that table's `user_id`/`related_user_id` shape is built around a pair (payer/payee); a moderation outcome is about one piece of content from one user, which doesn't fit cleanly. Written by `send-message`/`post-status` via `packages/moderation/openai.ts`, called before their respective billing RPC so a hard block never reaches `fn_send_message`/`fn_post_status` — `ref_id` is null for a `blocked` row for exactly that reason (nothing was ever inserted to reference); a `flagged` row (allowed through, logged for review) always has one. **Built 2026-09-15, not yet live** — no `OPENAI_API_KEY` exists in this environment yet, so the moderation check fails open (logs the provider error, allows the send) rather than blocking anything, by design, until a real key is added — see `docs/07-COMPLIANCE-LEGAL.md` §3/§6.

### `credit_transfers`

Peer-to-peer chat-credit transfer, convertible to cash on the recipient's side — see `docs/07-COMPLIANCE-LEGAL.md` §1 for why this needed a legal-review flag before it shipped (it shipped anyway, on an explicit product-owner decision; the flag stays on the pre-launch checklist).

| id, sender_id, recipient_id, credits_sent, platform_cut_credits, credits_received, note, created_at |

Written only by `fn_transfer_credit` (`SECURITY DEFINER`). The sender's `topup_credit` is debited by `credits_sent`; the recipient's `earnings_pending` is credited then immediately converted to `withdrawable_cash` (reusing `fn_release_escrow`'s exact ledger-entry shape, not a new cash-conversion path), after a cut at `platform_transfer_take_bps` goes to the `platform_revenue_earnings_cut` wallet. A `credit_transfer_max_credits` config value caps a single transfer's size.

### `status_updates`

| id, user_id, media_url, caption, credits_charged, expires_at (24h), created_at |

Visible to the poster (always, including expired) and, per `20260916090000_status_visibility_and_view_tracking.sql` (Phase 6), to anyone with a non-blocked `threads` row with the poster while `expires_at > now()` — two permissive RLS policies, not one, since Postgres ORs them together. See §7.

### `status_views` (added `20260916090000_status_visibility_and_view_tracking.sql`)

| status_id, viewer_id, viewed_at | PK `(status_id, viewer_id)` |

Records a status has been seen — drives the unseen(gold)/seen(grey) ring distinction on the mobile status feed (`docs/04-DESIGN-SYSTEM.md`). Written only by `fn_mark_status_viewed`; no client INSERT policy. See §7.

### `push_tokens` (added `20260914090000_settings_privacy_reports_push.sql`)

| token (PK), user_id, platform (`ios`/`android`), created_at |

One row per installed-app-instance — a user may have more than one device. `token` is the primary key since an Expo push token is already unique per app install. **No `users.push_notifications_enabled`-style flag exists anywhere** — "off" is modeled as "no rows here for this user" (the client deletes its own token when notifications are turned off in Settings, or never registered one if permission was denied), a deliberate choice so there's exactly one source of truth instead of a flag that could drift out of sync with it. RLS: `for all using/with check (auth.uid() = user_id)` — the client writes its own rows directly, no `SECURITY DEFINER` function; a self-scoped upsert/delete on a non-money table needs nothing more than that.

Read by `supabase/functions/_shared/push.ts`'s `sendPushToUser`, called from `send-message` (best-effort, via `EdgeRuntime.waitUntil` so a slow/failed push never delays or fails the billing-critical response) whenever a message lands for the recipient — the only wired trigger so far; other events (credit received, top-up confirmed, withdrawal completed) are real candidates for the same mechanism but weren't scoped into this pass.

### `user_reports` (added `20260914090000_settings_privacy_reports_push.sql`)

| id, reporter_id, reported_user_id, thread_id (nullable), reason, details (nullable), created_at |

The "reporting system" `docs/07-COMPLIANCE-LEGAL.md` §4 names as an app-store review requirement — previously entirely missing from this codebase. Insert-only from the client (`with check (auth.uid() = reporter_id)`); **no `SELECT` grant to `authenticated` at all** — reports are for ops/admin review via the service role or Studio, never readable back through the app by either the reporter or the reported user.

### `account_deletion_requests` (added `20260914090000_settings_privacy_reports_push.sql`)

| id, user_id, reason (nullable), status (`pending`/`completed`/`cancelled`), created_at |

A support-request queue, not instant self-service delete — this app custodies real money, and a wallet balance can't simply vanish on a tap. What should actually happen to a balance on account deletion (force a withdrawal first? hold under a notice period?) is a real policy decision this table doesn't make — it's just the honest capture mechanism until that policy exists. RLS: select/insert own, same posture as `user_reports`.

### Group threads — built, kill-switched off (Phase 5 still gates going live)

Companion to `docs/03-ECONOMY-LEDGER.md` §10's billing model, decided and then built 2026-09-13 (migration `20260913200000_group_chats.sql`). Per §10, this feature does not go live for real users before Phase 5's fraud infra exists — enforced concretely, not just by convention: `pricing_config.group_chat_enabled` ships at `0`, and `fn_send_group_message` itself checks and refuses to run while it's `0` (not just the eventual Edge Function), so there's no way to bypass the gate by calling the database function directly. Flip it to `1` only once Phase 5 lands.

Proposed as **new tables, not an extension of `threads`/`messages`**: those two are 1:1-shaped throughout (`participant_a`/`participant_b`, escrow-per-message, `fn_release_escrow` assuming exactly one payee) — forking that logic with `if is_group` branches everywhere would put group chat's much-less-tested code path inside the same functions the real money-moving 1:1 path depends on. A parallel schema keeps the blast radius of a group-chat bug contained to group-chat code.

- `group_threads`: `id, name, avatar_url, created_by, created_at`. `created_by` is the fixed group owner and the sole earner under §10's model — no ownership-transfer path is scoped yet, deliberately, since transferring who earns from a group is its own small design question (does the old owner's still-`pending` earnings follow them or the group?) not worth answering before the base model is even built.
- `group_members`: `group_thread_id, user_id, role (admin | member), joined_at` — composite PK on `(group_thread_id, user_id)`.
- `group_messages`: `id, group_thread_id, sender_id, body, word_count, credits_charged, owner_earning_credits, platform_take_credits, created_at` — no `status`/escrow columns (§10's model settles immediately, no pending state); `owner_earning_credits`/`platform_take_credits` both `0` on a self-post (sender == `created_by`), per §10's self-earning block.
- RLS: `SELECT` on all three gated to `group_members` rows matching `auth.uid()`, same posture as `threads`/`messages` today; no client writes, same `SECURITY DEFINER`-only posture as every other money-touching table.

Written only by `fn_send_group_message` (`SECURITY DEFINER`), same locking discipline as `fn_transfer_credit` (§3: fixed ascending-wallet-id order, since a non-self-post locks the sender's and the owner's wallets together). Tested in `supabase/tests/group-chat-functions.test.js` (`npm run test:group-chat`, 19/19): the 70/30 split, ledger conservation across every wallet touched, the self-post exception, a concurrency/double-spend check, membership/existence validation, and — the one that actually matters for the gating decision — that the kill switch really does refuse the call while `group_chat_enabled = 0`.

Still unresolved, not blocking (schema/function exist regardless): a group size cap and/or a per-message or per-day cap on `owner_earning_credits` (§10 flags both as open), whether creating a group costs anything (a new `pricing_config` key if so — nothing hardcoded, per CLAUDE.md rule #9), group creation/invite flow (nothing writes `group_threads`/`group_members` yet outside tests), and an Edge Function to expose `fn_send_group_message` to the app (not built — no urgency while the kill switch is off). The actual blocker to flipping `group_chat_enabled` to `1` remains Phase 5's fraud infra, per §10's gating decision. **Built 2026-09-15** (device fingerprinting + `fn_run_collusion_detection`, top-up velocity limits, and — as of the same day, continued — rate limiting + duplicate-content detection, see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §2/§4/§6). **Still not sufficient to flip the switch, and this is the important nuance:** §6's protections were built entirely inside `fn_release_escrow`, the 1:1-chat escrow-release function — `fn_send_group_message` is a completely different code path (immediate 70/30 settlement, no escrow at all, per the group-chat billing model) that never calls `fn_release_escrow` and gets none of this session's §6 protection. §10's own stated risk ("no reply-gate, no per-message cap") is therefore still fully live for group chat specifically — closing it needs the equivalent checks built into (or ahead of) `fn_send_group_message` itself, not assumed inherited from the 1:1 work. No one has re-run §10's own risk analysis against what's now actually in place.

## 2. Row Level Security posture

- `users`: `SELECT` own row + rows of anyone you share a thread with (limited columns via a view); `UPDATE` own row only, excluding `kyc_tier`/`is_suspended` (service-role only).
- `wallets`, `ledger_entries`, `escrows`, `withdrawals`, `topups`, `kyc_records`, `credit_transfers`: `SELECT` own rows only (`credit_transfers`: sender or recipient). **No client `INSERT`/`UPDATE`/`DELETE` grants at all** — every write is via `SECURITY DEFINER` functions invoked by Edge Functions using the service role. **This claim was false for the functions themselves from Phase 1 until 2026-09-15 (session 14) fixed it** — every `SECURITY DEFINER` function was directly callable by any client with just the anon key, `revoke execute ... from public` having been a no-op on this Supabase project the whole time (see `docs/00-SESSION-HANDOFF.md` and CLAUDE.md rule #11 for the full investigation and the correct pattern).
- `messages`, `threads`: `SELECT` if you're a participant; no direct client writes (see above).
- `pricing_config`: readable by `authenticated` (needed for client-side cost preview before sending), writable only by an internal `ops` role via the Supabase Studio / admin tool, and every write is logged to a `pricing_config_history` audit table.

## 3. Locking order (deadlock prevention)

Any function touching more than one wallet locks them in a **fixed global order** (e.g., sort by `wallet_id` ascending, then `SELECT ... FOR UPDATE` in that order) — this applies to `fn_send_message` (locks payer's `topup_credit` + creates escrow) and `fn_release_escrow` (locks escrow, payee's `earnings_pending`, and the platform's own system wallet for its cut). The platform itself has `wallets` rows (`user_id = null`) so platform revenue is trackable through the exact same ledger mechanism — no off-ledger revenue counting. This split into `'platform_revenue_topup_fees'` (kobo) and `'platform_revenue_earnings_cut'` (credits) — a single blended `'platform_revenue'` wallet was dropped early (`20260912072739_extend_schema_for_functions.sql`) before it ever held a balance, since mixing units in one wallet breaks the "ledger sum == balance" invariant's meaning. §5 below extends the same split to the reserve wallets.

## 4. Reconciliation job

An hourly `pg_cron` job sums `ledger_entries` per wallet and compares to the cached `wallets.balance`; any mismatch pages on-call and freezes new writes to that wallet (`is_frozen` flag checked by the `SECURITY DEFINER` functions) until an admin clears it. This is the backstop against any bug in the transactional logic above actually costing money silently.

## 5. Reserve buffer + chargeback clawback (`20260915150000`/`20260915151500`)

docs/06-SECURITY-FRAUD-LOOPHOLES.md §3. Two mechanisms, one migration pair:

**Reserve buffer.** `fn_credit_platform_revenue(p_revenue_kind, p_reserve_kind, p_amount, p_reason, p_ref_type, p_ref_id)` is the single place platform revenue is split — it skims `platform_reserve_bps` (config, default 400 = 4%) off `p_amount` into the matching reserve wallet (reason `platform_reserve_skim`) and credits the remainder to the revenue wallet under the caller's own reason, with `net + reserve` always summing to the original amount (subtraction, not two independent roundings). Every function that credits platform revenue — `fn_confirm_topup`, `fn_release_escrow`, `fn_transfer_credit`, and the kill-switched `fn_send_group_message` — calls it instead of inserting into the revenue wallet directly, so the buffer accumulates automatically in the same transaction as the revenue itself, no separate sweep.

**Clawback-as-debt.** `fn_process_chargeback(p_topup_id, p_reason default 'chargeback')` reverses a `completed` topup: debits the payer's `topup_credit` wallet by the full `credits_issued` (no non-negative constraint on `wallets.balance` — going negative **is** the tracked debt), debits `platform_revenue_topup_fees` by the topup's own `platform_fee_kobo`, marks the topup `'reversed'`, freezes the payer's `topup_credit` wallet (`is_frozen`, already checked by every spend path), and logs a `fraud_signals` row (`signal_type = 'chargeback'`, `severity = 'high'`). Idempotent — replaying it on an already-`'reversed'` topup is a no-op. The payee's wallets are never touched by this function; they keep what they earned in good faith unless collusion is separately flagged by §2's detection.

Invocation is a direct RPC call by support/ops (same precedent as the `manual_adjustment` ledger reason) — there is no admin UI and no confirmed Flutterwave dispute/reversal webhook event to wire it to (this app has no card-collection path). See `supabase/tests/chargeback-functions.test.js` for the ledger-conservation and concurrency coverage.

## 6. Settlement-aware auto-withdrawal holds (`20260915160000`)

docs/06-SECURITY-FRAUD-LOOPHOLES.md §3/§4. `fn_is_withdrawal_trusted(p_user_id)` computes a payee's "trusted" status — `kyc_tier >= 1`, account older than `new_account_age_days` (reused from §4's topup cap, same "how long counts as new" concept), and no `severity = 'high'` `fraud_signals` row within `withdrawal_trust_signal_lookback_days` (90, config, a rolling window). `fn_run_auto_withdraw_sweep` (redefined, `supabase/migrations/20260912081331_wire_scheduled_jobs.sql`'s original) calls it per candidate wallet: trusted payees sweep at the existing `withdrawal_auto_sweep_hours` (24h); untrusted payees only sweep past the longer `withdrawal_auto_sweep_hours_untrusted` (72h, config), and never force-sweep below `withdrawal_min_kobo` while a disqualifying signal is active, however long the money has sat — held, not force-paid, same posture the existing unverified-bank-account exclusion already uses. `fn_initiate_withdrawal` (manual withdrawal) is unchanged — only auto-sweep timing is gated. A disqualifying signal never sets `is_frozen`; it only delays the automatic sweep, consistent with the standing "fraud signals are for manual review, never auto-freeze" decision.

## 7. Status visibility + withdrawal countdown (Phase 6, `20260916090000`/`20260916091500`)

`docs/08-BUILD-PHASES-ROADMAP.md` Phase 6. Two independent pieces sharing a migration pair only by date, not by mechanism.

**Status visibility.** `status_updates_select_own`'s own comment had explicitly deferred "visibility to contacts/thread partners" to this phase rather than guessing at it. A second permissive RLS policy, `status_updates_select_visible_to_thread_partner`, now also allows SELECT when a non-blocked `threads` row exists between viewer and poster and `expires_at > now()` — this app has no phone-contacts-sync concept, so a `threads` row is the closest equivalent to a WhatsApp "contact." `status_views` (new table, §1) records who's seen what; `fn_mark_status_viewed(p_status_id, p_viewer_id)` re-checks the same visibility condition (a `SECURITY DEFINER` function bypasses RLS, so this can't be relied on implicitly), no-ops on the poster viewing their own status, and is idempotent on `(status_id, viewer_id)`. No expiry sweep/hard-delete — the client filters `expires_at > now()` (the existing `status_updates_expires_at_idx` already supports it); nothing in `docs/07-COMPLIANCE-LEGAL.md` requires scheduled deletion.

**Withdrawal countdown.** `fn_get_withdrawal_countdown(p_user_id)` wraps §6's `fn_is_withdrawal_trusted` into two client-facing fields — `effective_sweep_hours` and `force_sweep_below_minimum` — without ever returning the "trusted" boolean or any fraud-signal detail directly (this app has no self-serve dispute/unfreeze path, so a raw "you are untrusted" field would leak more than a ring needs). Doesn't return `wallets.updated_at`, `withdrawal_min_kobo`, or `withdrawal_force_sweep_days` — all three are already directly client-readable (`wallets` row-level RLS; `pricing_config` is fully authenticated-readable).

Both new functions follow CLAUDE.md rule #11's mandatory grant pattern from creation (`revoke ... from public, anon, authenticated` + `grant ... to service_role`, same migration as the `create function`). See `docs/05-API-REALTIME-SPEC.md` for the `mark-status-viewed`/`get-withdrawal-countdown` Edge Function contracts.

## 8. Per-counterparty chat transaction history (`20260917090000`)

`docs/10-UX-REFINEMENT-BACKLOG.md` Batch D — splits the wallet tab's flat transaction list into "who it was with" (chat/transfer activity) vs. "everything else" (top-ups, withdrawals, status posts, adjustments, reserve/chargeback bookkeeping).

`ledger_entries` has no direct counterparty column — only `wallet_id` (single-owner) and a polymorphic `ref_type`/`ref_id`. `ledger_entries_chat_counterparty` (new view, `security_invoker = true` — same load-bearing reason `thread_unread_counts` already documents: without it, the view would run with the _migration role's_ RLS context, not the caller's, leaking every user's ledger activity) resolves a counterparty two ways, unioned: message-thread reasons (`message_debit`, `escrow_release_earning`, `escrow_refund_unanswered` — the only three of the message/escrow reasons that ever land on a normal user's own wallet) via `ref_id` → `messages.id` → `messages.thread_id` → `threads.participant_a/b`; and credit-transfer reasons (`credit_transfer_sent/received/conversion`) via `ref_id` → `credit_transfers.id`, which already has direct `sender_id`/`recipient_id` columns. Every other reason has no real counterparty and isn't in this view — the client filters the existing flat `ledger_entries` query to that complementary set instead (`isWalletOnlyLedgerReason`, `apps/mobile/lib/queries/wallet.ts`) rather than this needing a second view. RLS scoping comes entirely from the underlying tables' existing policies (`ledger_entries_select_own`, `threads_select_participant`, `credit_transfers_select_own`) — the view has no `auth.uid()` of its own, same posture as `thread_unread_counts`.
