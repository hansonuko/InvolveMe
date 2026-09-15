# 06 — Security & Fraud Loopholes: Threat Model

InvolveMe custodies user funds and pays out cash based on message activity between strangers. That combination attracts a specific, well-understood set of abuses (payment fraud, money laundering, self-dealing, chat farming). This document enumerates every loophole identified against the original brief, current-state mitigations to build from day one, and future risks to monitor as the product scales. Treat every "Build now" item as in-scope for launch, not a v2 nice-to-have — a wallet product is unusually unforgiving of "we'll fix it later."

## 1. Message-length gaming (the literal pricing rule's exploit)

**Exploit:** Brief's literal rule — flat 2 credits, +2 more if over 50 words, with no upper bound — means a 51-word message and a 50,000-word message cost the same 4 credits. A colluding pair (or a single user's two accounts) could paste huge text blocks to move large "message" volumes cheaply, or a legitimate user could dump giant walls of text that break UI, storage, and moderation assumptions.

**Fix (build now):** Tiered formula `2 × ceil(words/50)` credits with a hard 500-word cap per message — full spec in `docs/03-ECONOMY-LEDGER.md` §4. Enforce the cap **server-side** in `fn_send_message`; a client-side-only cap is not a control.

## 2. Self-dealing / wash chatting (the big one)

**Built 2026-09-15 (session 13):** device fingerprinting (`device_fingerprints` table + `fn_link_device_fingerprint`, linked from the mobile app on every session, see `apps/mobile/lib/deviceFingerprint.ts`) and `fn_run_collusion_detection` (nightly `pg_cron`, two signal types: shared-fingerprint pairs with real paid activity, and one payee dominating a payer's weekly volume) — both write to `fraud_signals` for manual review only, never auto-freeze. `fn_transfer_credit` also gained a recipient KYC-tier gate this session, closing a related gap this section's own exploit shape pointed at directly. See `docs/00-SESSION-HANDOFF.md` session 13 for the full writeup and what's still open (§6's rate-limiting/duplicate-detection, a real graph algorithm if the current heuristic proves too coarse).

**Exploit:** A single person (or colluding pair) controls both the paying account (A) and the earning account (B). A tops up ₦1,000 → pays fees → chats with themselves as B → withdraws B's earnings. Net effect: they've paid the platform's fees (2% + 20% effective on the credit passed through) to convert their own card/bank funds into "clean" cash in a different account — classic wash-trading / layering pattern, useful for laundering stolen card funds or simply extracting value if the take-rate math ever favors the abuser (e.g., promo credits, bugs).

**Build now:**

- **Device fingerprinting** (Expo's device/install ID + a stable hashed fingerprint) linked at signup; flag any A↔B pair sharing a fingerprint, IP range, or payment instrument.
- **Graph-based collusion detection**: nightly job over `messages`/`escrows` building a bipartite payer↔payee graph; flag tight, repeated pairs with unusually high message frequency and low diversity of counterparties (a real social chat graph is broad and sparse; a wash-chat ring is narrow and dense).
- **KYC required for both sides of any real money to move**: A can top up without KYC (small amounts), but B cannot withdraw without Tier 1 KYC (BVN/NIN), and BVN/NIN must not match A's on record for the same threads beyond a threshold — flag same-BVN pairs outright.
- **Velocity limits** per new account: capped top-up amount and capped withdrawal amount for the first N days / until Tier 2 KYC, regardless of activity.
- Route all suspected pairs to a `fraud_signals`-driven review queue that can freeze wallets (`is_frozen`) pending manual review, without needing a code deploy.

**Future:** ML-based risk scoring (message content similarity, timing regularity indicative of scripted/bot exchange, device farm detection) once there's enough labeled fraud data.

## 3. Chargeback / card-fraud laundering

**Exploit:** Attacker tops up with a stolen card, immediately drives the credit to a "B" account (own or accomplice), withdraws to a bank account before the card issuer disputes the charge (chargebacks can land 30–120 days later). InvolveMe (or its PSP) eats the reversed charge after cash has already left the system.

**Build now:**

- **Settlement-aware holds**: don't treat `withdrawable_cash` as instantly withdrawal-eligible if its originating `topup` is very recent _and_ the payer account is low-trust (new, unverified, first top-up). Tie the "24h withdrawal promise" to the **payee's** trust tier, not just elapsed time — see §4 below, this is the same mechanism.
- **3D Secure / OTP-verified card payments only** via Flutterwave (don't disable it for "conversion rate" reasons — it's the primary chargeback defense).
- **Reserve buffer**: hold back a small % (e.g. 3–5%) of platform revenue in a rolling reserve to self-insure against chargeback losses rather than being caught with zero buffer.
- **Clawback path**: if a `topup` is reversed after its credits were already spent/released to a B, the resulting negative balance is tracked as a debt on A's wallet (can go negative, visibly, blocking further activity until settled) — never silently absorbed by the platform or clawed back from an unrelated B who did nothing wrong. B keeps what they earned in good faith unless collusion with A is separately flagged.

## 4. The 24-hour withdrawal promise vs. fraud/settlement risk (structural tension)

**Withdrawal side built since Phase 1** (the table below, `kyc_tier1_daily_withdrawal_cap_kobo`, enforced in `fn_initiate_withdrawal`). **Top-up side built 2026-09-15 (session 13):** `fn_buy_credit` had no velocity limit at all until now — arguably the more exploitable gap, since topping up needs no KYC whatsoever. `new_account_daily_topup_cap_kobo` (₦20,000/day) applies while an account is both new (`new_account_age_days`, default 30) **and** unverified (`kyc_tier = 0`) — either condition alone removes the cap, matching this section's own "first N days / until Tier 2 KYC" framing.

**Issue:** The product wants "cash out within 24h, auto-withdraw if forgotten" — great UX, but it's in direct tension with §3's chargeback window and §2's wash-chat risk. A flat, unconditional 24h promise to every user regardless of trust level is the loophole.

**Fix (build now) — tiered withdrawal, not flat:**

| KYC/trust tier                                                              | Daily withdrawal cap             | Auto-sweep eligible?                                                     |
| --------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Tier 0 (unverified)                                                         | ₦0 — cannot earn-withdraw at all | No — earnings accumulate but are locked until Tier 1                     |
| Tier 1 (BVN/NIN + verified bank, account < 30 days OR no clean history yet) | ₦50,000/day (config)             | Yes, but subject to the collusion checks in §2 running before each sweep |
| Tier 2 (Tier 1 + 30 days clean history, or enhanced/liveness KYC)           | Higher/unlimited (config)        | Yes, instant                                                             |

This keeps the literal 24h promise **true for legitimate, verified users** — which is the actual product value — while not extending it unconditionally to brand-new, unverified accounts, which is where fraud concentrates.

## 5. Auto-withdrawal to nowhere / to the wrong place

**Exploit / failure mode:** The 24h auto-sweep fires but the user never added a bank account, or added one that doesn't name-match their KYC identity (e.g., someone else's account, possibly itself a mule-account laundering vector).

**Build now:** Auto-sweep **never** creates a payout without a `bank_accounts` row with `name_match_verified = true`. If none exists at the 24h mark, hold the funds in `withdrawable_cash` (they don't disappear, don't force-convert to anything else) and fire escalating reminders (push at 24h, 48h, 72h; in-app banner persists). This also closes a mule-account vector where an attacker tries to redirect someone else's auto-withdrawal to an unverified account they control — verification gating prevents that outright.

## 6. Chat farming / spam-reply loops

**Rate limiting + duplicate-content detection built 2026-09-15 (session 13, continued).** Both live inside `fn_release_escrow`, not `fn_send_message` — a message never fails to send (the payer is still charged, matching this section's own "don't break real casual chat" framing); an escrow that fails either check just stays `pending` instead of `released`. A later `fn_release_escrow` call for the same thread retries it once the rate window moves on; the existing `fn_refund_expired_escrows` sweep (48h) eventually refunds it to the payer if it never clears — no new refund path built, reusing §2's existing mechanism. New `pg_trgm` extension (`similarity()`) for near-duplicate text comparison — a standard Postgres contrib module, not a new external dependency. Real bug caught by manually running it against a synthetic fixture before trusting the SQL (same discipline that caught the collusion job's `min(uuid)` bug): the duplicate-content check originally compared _every_ escrow's message against payee B's history, including payer A's own messages — fixed forward (`20260915121500_fix_duplicate_content_payer_leak.sql`) to only ever check content the payee themselves sent.

**Still not built, explicit product decision to defer (not forgotten):** the "minimum content heuristic → genuine engagement score → gates KYC-tier progression" idea below. This app has no scaffolding for it today — KYC tier is purely BVN/NIN-verification-driven, nothing behavioral feeds into it — and what "genuine engagement" means numerically, and how much it should move the tier, is a real product/policy decision worth its own scoping pass, not a side effect of the two mechanical protections above.

**Exploit:** A and B (colluding, or B running a bot) exchange minimal-effort, high-frequency messages ("ok", "yes", "lol") purely to cycle credit through the escrow-release mechanism as fast as possible, maximizing B's earnings-per-hour with zero genuine engagement — essentially automating the wash-chat pattern from §2 without even needing two real humans.

**Build now:**

- **Rate limiting**: cap messages-per-minute per thread (e.g., 10/min) and total earnings-eligible releases per hour per user — bursts beyond that don't fail the message, but stop counting toward escrow release/earnings until the window resets.
- **Duplicate/near-duplicate detection**: if B's replies are repeated or near-identical (Levenshtein/simhash similarity above a threshold) across a rolling window, stop crediting new earnings from that thread and flag for review.
- **Minimum content heuristic**: extremely short, templated replies below a length/entropy threshold can still be _sent_ (don't break real casual chat — "ok" is a legitimate human reply) but are weighted down or excluded from a per-user "genuine engagement" score used to gate KYC tier upgrades and higher withdrawal limits — so farming behavior caps you at Tier 1 forever rather than being flatly blocked (avoids false-positive-blocking real low-effort-but-legitimate chatters, while still denying farmers the higher trust tier they'd need to extract large sums fast).

**Future:** pair this with the collusion graph in §2 — a bot-farmed pair will show up there too (narrow, dense, high-frequency).

## 7. Ledger rounding / salami slicing

**Exploit:** Integer division/rounding in fee splits (§5 and §3 of the economy doc) always has to round somewhere; if that rounding silently and consistently favors the platform (or a bug makes it favor a specific user path), it's a "fine at small scale, real money at volume" bug — and historically, deliberate exploitation of rounding remainders is a classic fraud pattern.

**Build now:** One documented, consistent rounding rule (round-half-up, always applied the same direction), the `leftover_kobo`/dust-carry mechanism in the economy doc so fractional value is never simply discarded, and the reconciliation job (`docs/02-DATA-MODEL.md` §4) that mathematically guarantees `sum(ledger_entries) == wallet.balance` at all times — this makes silent value leakage structurally detectable within an hour, not something an audit finds a year later.

## 8. Race conditions / double-spend

**Exploit:** Two rapid concurrent requests to spend the same credits (e.g., double-tap send, or a deliberately scripted race) both read "balance = 10, sufficient" before either debit commits, resulting in a negative balance.

**Build now:** Row-level locking (`SELECT ... FOR UPDATE`) on the payer's wallet inside `fn_send_message`, executed as one serialized transaction per wallet — the second concurrent request blocks until the first commits, then re-reads the now-updated balance. Idempotency key on `send-message` requests (client-generated UUID per compose action) so a network-retry of the same send can't double-charge.

## 9. Webhook spoofing / replay

**Exploit:** Forged or replayed Flutterwave/Paystack webhook calls to `webhook-flutterwave` fake a successful top-up without real money moving.

**Build now:** Signature verification on every inbound webhook (reject unsigned/mismatched outright, no fallback processing path), `provider_event_id` idempotency table so a legitimately-replayed webhook can't double-credit, and a nightly reconciliation against the provider's own settlement report (Flutterwave/Paystack both provide transaction listing APIs) to catch any credited `topup` that doesn't correspond to a real settled charge on the provider side.

## 10. Multi-account / referral abuse (future risk — design for it even if not in v1)

**Exploit:** Any future signup bonus, referral credit, or promo (even something as small as "free 10 credits on signup") gets farmed via SIM farms / device farms creating many accounts.

**Build now (cheap insurance even without a promo system yet):** Phone-number OTP with basic carrier/VOIP-number detection at signup, device fingerprint linkage from day one (needed for §2 anyway) so that if/when a referral system ships, the fraud infrastructure already exists rather than being retrofitted under pressure.

## 11. App-store and regulatory risk (not a "security" bug, but a real loophole in the plan if unaddressed)

**Issue:** "Pay to chat with a specific person for their time" is a business model pattern (companion/camming-adjacent, escort-adjacent in the worst case, or simply unlicensed money transmission) that both Apple/Google review teams and the CBN scrutinize heavily. This is covered in full in `docs/07-COMPLIANCE-LEGAL.md` — flagged here because "the app gets rejected or shut down" is the ultimate loophole in any technical mitigation above.

## 12. Summary — build-now checklist

Status honestly re-audited 2026-09-15 (docs/00-SESSION-HANDOFF.md session 13) against what's actually in the migrations, not what earlier passes of this doc assumed — several items below were already true before this session and this list simply hadn't been updated to say so.

- [x] Tiered message-cost formula with hard length cap (§1) — Phase 1
- [x] Device fingerprinting + collusion detection (§2) — session 13. "Graph job" turned out to mean a simple, explainable share-of-volume heuristic (`fn_run_collusion_detection`) rather than a literal graph-theory library, deliberately (stay-lite bias) — re-evaluate if it proves too coarse once there's real usage data to tune against. **Logs to `fraud_signals` for manual review only — does not auto-freeze**, an explicit product decision (this app has no admin UI beyond Supabase Studio; a false-positive auto-freeze with no self-serve unfreeze path was judged worse than a slower manual review).
- [ ] 3DS-only card collections, reserve buffer, clawback-as-debt design (§3) — still not built. Partially moot as written: this app only ever implemented NGN bank-transfer collections (§3's "3DS-only card collections" assumes a card path that doesn't exist), but the reserve-buffer and clawback-as-debt pieces are real, independent, still-open gaps regardless of collection method.
- [x] KYC-tiered withdrawal caps, not a flat 24h-for-everyone rule (§4) — Phase 1 (`kyc_tier1_daily_withdrawal_cap_kobo`, enforced in `fn_initiate_withdrawal`). **New this session:** the top-up side had zero velocity limiting until now — `new_account_daily_topup_cap_kobo` closes it, since topping up needs no KYC at all and was the more exploitable of the two directions.
- [x] Bank-account name-match required before any withdrawal, manual or auto (§5) — Phase 1
- [x] Rate limits + duplicate-content detection on escrow-eligible messages (§6) — built 2026-09-15 (session 13, continued). The "genuine engagement score gates KYC tier" idea within §6 stays explicitly deferred — a real product/policy decision, not a mechanical protection like the two that shipped
- [x] Single consistent rounding rule + dust-carry + hourly reconciliation (§7) — Phase 1
- [x] Row-level wallet locking + idempotency keys on send/topup/withdraw (§8) — Phase 1
- [x] Signed, idempotent webhooks + nightly provider reconciliation (§9) — Phase 1 for signing/idempotency; the "nightly reconciliation" piece is now `reconcile-topups` (session 12), which actually exceeds "nightly" — every 10 minutes, pull-based against Flutterwave directly, built after `webhook-flutterwave` was found to have never once received a real delivery in this app's history
- [ ] Fraud infra (fingerprinting, OTP, velocity limits) in place before any referral/promo system ships (§10) — fingerprinting and velocity limits now exist (above); still nothing to check for OTP/carrier-detection specifically, and no referral system exists yet to gate, so this stays unchecked as "prerequisites partially in place," not "done"
- [ ] Legal sign-off per `docs/07-COMPLIANCE-LEGAL.md` before public launch (§11) — not started, needs actual counsel, not something to build
