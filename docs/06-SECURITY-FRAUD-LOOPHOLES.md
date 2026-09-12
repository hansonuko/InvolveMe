# 06 — Security & Fraud Loopholes: Threat Model

InvolveMe custodies user funds and pays out cash based on message activity between strangers. That combination attracts a specific, well-understood set of abuses (payment fraud, money laundering, self-dealing, chat farming). This document enumerates every loophole identified against the original brief, current-state mitigations to build from day one, and future risks to monitor as the product scales. Treat every "Build now" item as in-scope for launch, not a v2 nice-to-have — a wallet product is unusually unforgiving of "we'll fix it later."

## 1. Message-length gaming (the literal pricing rule's exploit)

**Exploit:** Brief's literal rule — flat 2 credits, +2 more if over 50 words, with no upper bound — means a 51-word message and a 50,000-word message cost the same 4 credits. A colluding pair (or a single user's two accounts) could paste huge text blocks to move large "message" volumes cheaply, or a legitimate user could dump giant walls of text that break UI, storage, and moderation assumptions.

**Fix (build now):** Tiered formula `2 × ceil(words/50)` credits with a hard 500-word cap per message — full spec in `docs/03-ECONOMY-LEDGER.md` §4. Enforce the cap **server-side** in `fn_send_message`; a client-side-only cap is not a control.

## 2. Self-dealing / wash chatting (the big one)

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
- **Settlement-aware holds**: don't treat `withdrawable_cash` as instantly withdrawal-eligible if its originating `topup` is very recent *and* the payer account is low-trust (new, unverified, first top-up). Tie the "24h withdrawal promise" to the **payee's** trust tier, not just elapsed time — see §4 below, this is the same mechanism.
- **3D Secure / OTP-verified card payments only** via Flutterwave (don't disable it for "conversion rate" reasons — it's the primary chargeback defense).
- **Reserve buffer**: hold back a small % (e.g. 3–5%) of platform revenue in a rolling reserve to self-insure against chargeback losses rather than being caught with zero buffer.
- **Clawback path**: if a `topup` is reversed after its credits were already spent/released to a B, the resulting negative balance is tracked as a debt on A's wallet (can go negative, visibly, blocking further activity until settled) — never silently absorbed by the platform or clawed back from an unrelated B who did nothing wrong. B keeps what they earned in good faith unless collusion with A is separately flagged.

## 4. The 24-hour withdrawal promise vs. fraud/settlement risk (structural tension)

**Issue:** The product wants "cash out within 24h, auto-withdraw if forgotten" — great UX, but it's in direct tension with §3's chargeback window and §2's wash-chat risk. A flat, unconditional 24h promise to every user regardless of trust level is the loophole.

**Fix (build now) — tiered withdrawal, not flat:**
| KYC/trust tier | Daily withdrawal cap | Auto-sweep eligible? |
|---|---|---|
| Tier 0 (unverified) | ₦0 — cannot earn-withdraw at all | No — earnings accumulate but are locked until Tier 1 |
| Tier 1 (BVN/NIN + verified bank, account < 30 days OR no clean history yet) | ₦50,000/day (config) | Yes, but subject to the collusion checks in §2 running before each sweep |
| Tier 2 (Tier 1 + 30 days clean history, or enhanced/liveness KYC) | Higher/unlimited (config) | Yes, instant |

This keeps the literal 24h promise **true for legitimate, verified users** — which is the actual product value — while not extending it unconditionally to brand-new, unverified accounts, which is where fraud concentrates.

## 5. Auto-withdrawal to nowhere / to the wrong place

**Exploit / failure mode:** The 24h auto-sweep fires but the user never added a bank account, or added one that doesn't name-match their KYC identity (e.g., someone else's account, possibly itself a mule-account laundering vector).

**Build now:** Auto-sweep **never** creates a payout without a `bank_accounts` row with `name_match_verified = true`. If none exists at the 24h mark, hold the funds in `withdrawable_cash` (they don't disappear, don't force-convert to anything else) and fire escalating reminders (push at 24h, 48h, 72h; in-app banner persists). This also closes a mule-account vector where an attacker tries to redirect someone else's auto-withdrawal to an unverified account they control — verification gating prevents that outright.

## 6. Chat farming / spam-reply loops

**Exploit:** A and B (colluding, or B running a bot) exchange minimal-effort, high-frequency messages ("ok", "yes", "lol") purely to cycle credit through the escrow-release mechanism as fast as possible, maximizing B's earnings-per-hour with zero genuine engagement — essentially automating the wash-chat pattern from §2 without even needing two real humans.

**Build now:**
- **Rate limiting**: cap messages-per-minute per thread (e.g., 10/min) and total earnings-eligible releases per hour per user — bursts beyond that don't fail the message, but stop counting toward escrow release/earnings until the window resets.
- **Duplicate/near-duplicate detection**: if B's replies are repeated or near-identical (Levenshtein/simhash similarity above a threshold) across a rolling window, stop crediting new earnings from that thread and flag for review.
- **Minimum content heuristic**: extremely short, templated replies below a length/entropy threshold can still be *sent* (don't break real casual chat — "ok" is a legitimate human reply) but are weighted down or excluded from a per-user "genuine engagement" score used to gate KYC tier upgrades and higher withdrawal limits — so farming behavior caps you at Tier 1 forever rather than being flatly blocked (avoids false-positive-blocking real low-effort-but-legitimate chatters, while still denying farmers the higher trust tier they'd need to extract large sums fast).

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

- [ ] Tiered message-cost formula with hard length cap (§1)
- [ ] Device fingerprinting + collusion graph job (§2)
- [ ] 3DS-only card collections, reserve buffer, clawback-as-debt design (§3)
- [ ] KYC-tiered withdrawal caps, not a flat 24h-for-everyone rule (§4)
- [ ] Bank-account name-match required before any withdrawal, manual or auto (§5)
- [ ] Rate limits + duplicate-content detection on escrow-eligible messages (§6)
- [ ] Single consistent rounding rule + dust-carry + hourly reconciliation (§7)
- [ ] Row-level wallet locking + idempotency keys on send/topup/withdraw (§8)
- [ ] Signed, idempotent webhooks + nightly provider reconciliation (§9)
- [ ] Fraud infra (fingerprinting, OTP, velocity limits) in place before any referral/promo system ships (§10)
- [ ] Legal sign-off per `docs/07-COMPLIANCE-LEGAL.md` before public launch (§11)
