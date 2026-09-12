# 03 — Economy & Ledger

This document is the source of truth for money and credit math. It implements a **hardened** version of the original brief — the two deviations from the literal spec are called out explicitly with the reasoning, because they close a real exploit and a real margin problem. Everything else matches the brief.

## 1. Units

- **1 credit = ₦10.00** → stored as `credit_unit_kobo = 1000`.
- **Bundle:** ₦1,000 buys 100 credits, before fees are applied (see §3).
- All numbers below use kobo/whole-credit integers. `pricing_config` (see `docs/02-DATA-MODEL.md`) is the live source for every constant — the numbers here are the v1 defaults, not hardcoded.

## 2. Who pays, who earns — the mental model

- **User A** ("seeker") buys chat credit. It sits in A's `topup_credit` wallet.
- **User B** ("sought") earns cash for their time as they reply in a thread A pays into.
- Every message in a paid thread — from either side — costs credits, debited from **A's** `topup_credit` (A is always the paying party in a given thread; B never pays to participate in a thread A initiated).
- Credits only become B's earnings **once B actually replies** — see the escrow mechanic in §5. This is a deliberate hardening: the literal brief doesn't specify what happens if B never responds, and "A gets charged into a void" is both bad UX and a foreseeable complaint/chargeback source.

## 3. Buying credit (top-up)

```
platform_fee_kobo = round(amount_paid_kobo × platform_topup_fee_bps / 10000)   // 2.00%
net_for_credits_kobo = amount_paid_kobo − platform_fee_kobo
credits_issued = floor(net_for_credits_kobo / credit_unit_kobo)
leftover_kobo  = net_for_credits_kobo − (credits_issued × credit_unit_kobo)    // carried forward, see below
```

Worked example, ₦1,000 top-up:
- `platform_fee_kobo` = ₦20.00
- `net_for_credits_kobo` = ₦980.00 → `credits_issued` = 98 credits (not 100)
- `leftover_kobo` = ₦0 (980 divides evenly by 10)

**Important business-model finding — read before treating "2% deposit fee" as pure profit:**
Flutterwave/Paystack charge InvolveMe a processing fee on every collection, typically ~1.4–1.5% + a fixed naira fee for local cards/transfers (provider-specific, capped on larger amounts). On a ₦1,000 top-up that can be **₦100+**, which is more than the ₦20 InvolveMe collects as its 2% fee. **As specified, the 2% deposit fee likely does not cover the payment gateway's own cost, meaning InvolveMe loses money on the top-up leg before it ever earns its 20% cut on chat activity.** Three options, pick one before launch:
1. Treat the 2% as a stated *product* fee (marketing: "only 2% to top up") and accept it's a loss-leader subsidized by the 20% earnings take — viable only if per-user chat volume is high enough that the 20% take comfortably covers it. Model this with real numbers before committing.
2. Raise the effective top-up fee to cover gateway cost + margin (e.g., 2% platform fee + pass-through of the actual gateway fee, shown to the user as one line).
3. Only offer top-up amounts high enough that gateway fixed-fee amortizes below 2% (e.g., disable sub-₦500 top-ups).
This is flagged again in `docs/06-SECURITY-FRAUD-LOOPHOLES.md` as a viability item, not just a security one.

`leftover_kobo` (float/dust from division) is credited to a small `wallet_float_kobo` balance on the user's `topup_credit` wallet rather than discarded, and rolled into the next purchase — never silently absorbed by the platform. This also forecloses a "salami slicing" complaint/audit finding (see loopholes doc §7).

## 4. Message billing (hardened formula)

**Literal brief:** "2 credits per chat, +2 credits if the message exceeds 50 words." Taken literally, this is flat: a 51-word message and a 5,000-word message both cost exactly 4 credits. That's a straightforward exploit — pack everything into one giant message to minimize cost per unit of content, or worse, per unit of B's actual response effort. It also has no upper bound, which fights the "lite" requirement (arbitrarily large message payloads).

**Hardened formula (what to actually build):**

```
word_blocks       = ceil(word_count / message_word_block_size)     // block size = 50
credits_charged   = message_base_credits × max(word_blocks, 1)     // base = 2
// hard cap enforced both client-side (UX) and server-side (authoritative):
word_count       ≤ message_max_words   // default 500 → max 20 credits/message
```

Examples at defaults (base 2, block 50, cap 500):
| Words | Blocks | Credits |
|---|---|---|
| 1–50 | 1 | 2 |
| 51–100 | 2 | 4 |
| 101–150 | 3 | 6 |
| 500 (cap) | 10 | 20 |
| 501+ | — | **rejected**, client prompts to split into a follow-up message |

This preserves the brief's stated prices exactly at the two points it specified (≤50 words = 2 credits, just-over-50 = 4 credits) while removing the flat-rate cliff beyond that. Splitting a long message into several shorter ones now costs the same or more than one message of the same total length (never less) — no incentive to game it either direction. See `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §1 for the before/after exploit walkthrough.

All billing is computed server-side inside `fn_send_message`; the client's word-count preview is cosmetic only.

## 5. The escrow → earning flow

1. A sends message 1 in a new/ongoing thread with B. `fn_send_message`:
   - Debits `credits_charged` from A's `topup_credit` (ledger reason `message_debit`).
   - Creates an `escrows` row for that amount, status `pending`, `expires_at = now() + escrow_unanswered_refund_hours` (default 48h) — ledger reason `escrow_hold`.
   - Message is inserted with status `escrowed`.
2. If B never replies before `expires_at`: the `escrow-expiry-sweep` cron job refunds the held credits back to A's `topup_credit` (ledger reason `escrow_refund_unanswered`), marks the message/escrow `refunded`. A is not charged for messages B never engaged with — B never had a claim on credit they didn't respond to, so nothing is owed to the platform either.
3. When B sends a reply, `fn_send_message` runs again for B's message (also debited from **A**, per §2), and additionally calls `fn_release_escrow` for every `pending` escrow in that thread up to and including this exchange:
   ```
   platform_cut_credits  = round(escrow.credits_held × platform_earning_take_bps / 10000)   // 20%
   payee_earning_credits = escrow.credits_held − platform_cut_credits
   ```
   - `payee_earning_credits` → B's `earnings_pending` wallet (reason `escrow_release_earning`).
   - `platform_cut_credits` → the platform's own ledger wallet (reason `escrow_release_platform_cut`).
   - Escrow marked `released`.

Worked example: A sends a 30-word message (2 credits, escrowed). B replies with a 60-word message (4 credits, escrowed for *that* message, and simultaneously releases the earlier 2-credit escrow). Release event distributes: `2 credits × 80% = 1.6 → 2 credits` (round to nearest, remainder banked in platform's favor per rounding policy, documented in `pricing_config_history`) to B's earnings, `0.4 → 0` to platform on that entry — **rounding is applied per-release, not per-thread**, and must be applied with a single consistent rounding rule (round-half-up) recorded in code, because "who absorbs the fractional credit" is exactly the kind of ambiguity that becomes a support/legal complaint at scale.

## 6. Converting earnings to cash and withdrawing

- `earnings_pending` credits convert to `withdrawable_cash` (kobo) **automatically and immediately** on release, at the fixed rate `credit_unit_kobo` — there is no floating exchange rate or manual "convert" step, which removes an entire class of timing-arbitrage complaints ("I would have converted before a rate change"). This is a deliberate simplification versus the brief's wording ("user can convert") — manual conversion with a floating rate adds complexity and exploit surface for no clear product benefit at v1; if a floating internal rate is ever desired, revisit this section first.
- The 20% take already happened in credits at release time (§5); no additional fee is taken at conversion.
- `withdrawable_cash` funds are eligible for **manual withdrawal to a verified bank account at any time**. If a user does not manually withdraw within `withdrawal_auto_sweep_hours` (default 24h) of the funds landing in `withdrawable_cash`, the `auto-withdraw-sweep` cron job initiates the payout automatically — see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §5 for what happens when there's no verified bank account yet (funds are held and the user is notified repeatedly; auto-withdrawal never fires to an unverified/unmatched destination).
- **Withdrawal requires KYC Tier ≥ 1** (BVN or NIN verified) and a bank account whose account name matches the KYC identity — both manual and automatic withdrawal. This is non-negotiable; see compliance doc.
- Minimum payout batch: `withdrawal_min_kobo` (default ₦500) — sub-threshold balances accumulate rather than triggering a payout that the provider's flat transfer fee would eat disproportionately. If 7 days pass without reaching the threshold, the sweep pays out anyway regardless of the minimum, so funds never get stuck indefinitely.
- **Tiered withdrawal limits** (daily caps by KYC tier — see `pricing_config`) balance the product promise ("cash out within 24h") against fraud/chargeback exposure. New/low-tier accounts get capped daily withdrawal amounts; limits lift with account age and clean history. This tension — fast payout promise vs. chargeback settlement risk — is real and is discussed fully in `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §4.

## 7. Status updates

Spending credit on a status upload debits `topup_credit` directly (no escrow, no earning — nobody "responds" to a status the same way), per `status_upload_credits_text` / `status_upload_credits_media` in `pricing_config`. Status media follows the same compression pipeline as chat media (`docs/01-ARCHITECTURE.md` §5) to stay lite.

## 8. Revenue summary (the two fee lines, and only these two)

| Fee | Rate | Taken when | Taken from |
|---|---|---|---|
| Deposit/top-up fee | 2.00% (`platform_topup_fee_bps`) | Every credit purchase | The amount being deposited, before credits are issued |
| Earnings take | 20.00% (`platform_earning_take_bps`) | Every escrow release (i.e., every time B's reply "earns" the credit A was charged) | The credit being released to B |

No other implicit fees exist. Any future fee (e.g., a withdrawal processing fee to cover the payout provider's transfer cost) must be added to `pricing_config` explicitly and documented here — never buried in rounding.
