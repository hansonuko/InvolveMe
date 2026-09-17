# 03 — Economy & Ledger

This document is the source of truth for money and credit math. It implements a **hardened** version of the original brief — the two deviations from the literal spec are called out explicitly with the reasoning, because they close a real exploit and a real margin problem. Everything else matches the brief.

## 1. Units

- **1 credit = ₦10.00** → stored as `credit_unit_kobo = 1000`. This is the NGN row of `pricing_config`; see §12 for the multi-currency target where every other supported currency gets its own `credit_unit_kobo` row (e.g. a GHS row denominated in pesewas) rather than one NGN-only value.
- **Bundle:** ₦1,000 buys 100 credits, before fees are applied (see §3).
- All numbers below use kobo/whole-credit integers. `pricing_config` (see `docs/02-DATA-MODEL.md`) is the live source for every constant — the numbers here are the v1 defaults, not hardcoded.
- **Naming note (post-§12):** every `_kobo`-suffixed column/key (`amount_paid_kobo`, `withdrawal_min_kobo`, etc.) is NGN-era naming for "integer minor currency unit" — kobo for NGN, pesewas for GHS, cents for USD. Not renamed (would be a mechanical, high-diff, zero-behavior-change churn across the whole codebase for a naming nicety), but read `_kobo` as "minor unit of whatever currency this row's `currency` column says," not literally Nigerian kobo, once §12 lands.

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

1. Treat the 2% as a stated _product_ fee (marketing: "only 2% to top up") and accept it's a loss-leader subsidized by the 20% earnings take — viable only if per-user chat volume is high enough that the 20% take comfortably covers it. Model this with real numbers before committing.
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

| Words     | Blocks | Credits                                                        |
| --------- | ------ | -------------------------------------------------------------- |
| 1–50      | 1      | 2                                                              |
| 51–100    | 2      | 4                                                              |
| 101–150   | 3      | 6                                                              |
| 500 (cap) | 10     | 20                                                             |
| 501+      | —      | **rejected**, client prompts to split into a follow-up message |

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

Worked example: A sends a 30-word message (2 credits, escrowed). B replies with a 60-word message (4 credits, escrowed for _that_ message, and simultaneously releases the earlier 2-credit escrow). Release event distributes: `2 credits × 80% = 1.6 → 2 credits` (round to nearest, remainder banked in platform's favor per rounding policy, documented in `pricing_config_history`) to B's earnings, `0.4 → 0` to platform on that entry — **rounding is applied per-release, not per-thread**, and must be applied with a single consistent rounding rule (round-half-up) recorded in code, because "who absorbs the fractional credit" is exactly the kind of ambiguity that becomes a support/legal complaint at scale.

## 6. Converting earnings to cash and withdrawing

- `earnings_pending` credits convert to `withdrawable_cash` (kobo) **automatically and immediately** on release, at the fixed rate `credit_unit_kobo` — there is no floating exchange rate or manual "convert" step, which removes an entire class of timing-arbitrage complaints ("I would have converted before a rate change"). This is a deliberate simplification versus the brief's wording ("user can convert") — manual conversion with a floating rate adds complexity and exploit surface for no clear product benefit at v1; if a floating internal rate is ever desired, revisit this section first.
- The 20% take already happened in credits at release time (§5); no additional fee is taken at conversion.
- `withdrawable_cash` funds are eligible for **manual withdrawal to a verified bank account at any time**. If a user does not manually withdraw within `withdrawal_auto_sweep_hours` (default 24h) of the funds landing in `withdrawable_cash`, the `auto-withdraw-sweep` cron job initiates the payout automatically — see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §5 for what happens when there's no verified bank account yet (funds are held and the user is notified repeatedly; auto-withdrawal never fires to an unverified/unmatched destination).
- **The 24h auto-sweep threshold above only applies to "trusted" payees** (built 2026-09-15, session 14 — `fn_is_withdrawal_trusted`, `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §3/§4): KYC Tier 1+, account older than `new_account_age_days` (30), and no high-severity `fraud_signals` row within `withdrawal_trust_signal_lookback_days` (90). A payee who isn't yet trusted waits the longer `withdrawal_auto_sweep_hours_untrusted` (72h) instead, and — unlike a trusted payee — is never force-swept below `withdrawal_min_kobo` while a disqualifying signal is active, however long the money has sat. Manual withdrawal is unaffected either way; only the _automatic_ sweep's timing is gated.
- **Withdrawal requires KYC Tier ≥ 1** (BVN or NIN verified) and a bank account whose account name matches the KYC identity — both manual and automatic withdrawal. This is non-negotiable; see compliance doc.
- Minimum payout batch: `withdrawal_min_kobo` (default ₦500) — sub-threshold balances accumulate rather than triggering a payout that the provider's flat transfer fee would eat disproportionately. If 7 days pass without reaching the threshold, the sweep pays out anyway regardless of the minimum, so funds never get stuck indefinitely.
- **Tiered withdrawal limits** (daily caps by KYC tier — see `pricing_config`) balance the product promise ("cash out within 24h") against fraud/chargeback exposure. New/low-tier accounts get capped daily withdrawal amounts; limits lift with account age and clean history. This tension — fast payout promise vs. chargeback settlement risk — is real and is discussed fully in `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §4.

## 7. Status updates

Spending credit on a status upload debits `topup_credit` directly (no escrow, no earning — nobody "responds" to a status the same way), per `status_upload_credits_text` / `status_upload_credits_media` in `pricing_config`. Status media follows the same compression pipeline as chat media (`docs/01-ARCHITECTURE.md` §5) to stay lite.

## 8. Revenue summary (the fee lines, and only these)

| Fee                | Rate                                                         | Taken when                                                                         | Taken from                                            |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Deposit/top-up fee | 2.00% (`platform_topup_fee_bps`)                             | Every credit purchase                                                              | The amount being deposited, before credits are issued |
| Earnings take      | 20.00% (`platform_earning_take_bps`)                         | Every escrow release (i.e., every time B's reply "earns" the credit A was charged) | The credit being released to B                        |
| Peer-transfer take | 20.00% (`platform_transfer_take_bps`, independently tunable) | Every user-to-user credit transfer (§9)                                            | The credit being transferred                          |

No other implicit fees exist. Any future fee (e.g., a withdrawal processing fee to cover the payout provider's transfer cost) must be added to `pricing_config` explicitly and documented here — never buried in rounding.

Every row above is itself skimmed a further `platform_reserve_bps` (4%) into a self-insurance reserve before it lands in the platform's spendable revenue wallet — see §11.

## 9. Peer-to-peer credit transfer (built ahead of legal review — see `docs/07-COMPLIANCE-LEGAL.md` §1)

A sends credits directly to B, no chat activity involved. `fn_transfer_credit`:

```
platform_cut_credits  = round(credits_sent × platform_transfer_take_bps / 10000)   // 20%
credits_received      = credits_sent − platform_cut_credits
```

- Debits the sender's `topup_credit` by the full `credits_sent` (reason `credit_transfer_sent`).
- Credits the recipient's `earnings_pending` with `credits_received`, then immediately converts it to `withdrawable_cash` at `credit_unit_kobo` (reasons `credit_transfer_received` / `credit_transfer_conversion`) — the exact same two-step ledger shape §5's escrow release uses, so the recipient's cash-out inherits the same KYC-gated, name-matched withdrawal path (`docs/03` §6, CLAUDE.md rule #7) rather than a second, parallel one.
- `credit_transfer_max_credits` (default 1,000 credits / ₦10,000) caps a single transfer — a blast-radius limit on a brand-new money-moving path, not a product decision; raising it should be deliberate.

This is the one mechanic in this document that `docs/07-COMPLIANCE-LEGAL.md` §1 names explicitly as needing a legal check before shipping — it shipped anyway, on an informed product-owner decision, and stays flagged on that document's pre-launch checklist until counsel has actually looked at it.

## 10. Group chats — billing model (decided and built 2026-09-13, held behind Phase 5)

`docs/08-BUILD-PHASES-ROADMAP.md` already flagged group chats as "credit-splitting/multi-payer logic across a group is a materially different ledger design from 1:1 escrow — worth its own design pass, not a quick extension." This is that design pass, requested 2026-09-13 when the wine-rebrand mockup turned out to include group-style rows. **The billing model below is decided** (product-owner call, not a default) **and built** — migration `20260913200000_group_chats.sql`, `fn_send_group_message`, tested in `supabase/tests/group-chat-functions.test.js` (19/19). Per the same decision, this feature does not go live until Phase 5's fraud infra exists — enforced by a real kill switch (`pricing_config.group_chat_enabled`, ships at `0`), not just a comment. See "Why this is gated" below before treating "built" as "shippable."

**Decided model — owner-earns, immediate split, no escrow:**

```
credits_charged        = message cost, same word-count formula as §4 (2 × ceil(words/50), capped at 500 words)
// self-post exception: sender_id == group_threads.created_by → no split at all.
// The message still costs credits_charged (debited from the sender as normal); nobody earns anything on it —
// not "owner earns from themselves", not "platform takes a cut of a message the owner didn't send to anyone else".
platform_take_credits   = round(credits_charged × platform_group_message_take_bps / 10000)   // 30%, sender != owner only
owner_earning_credits   = credits_charged − platform_take_credits                              // 70%, sender != owner only
```

- Any member (including the owner) pays `credits_charged` from their own `topup_credit` to post — same formula and cap as 1:1 messages, no separate group-specific pricing tier.
- **Unlike §5's escrow, this settles immediately on send — there is no "wait for a reply" concept**, because nothing analogous to "B replies" exists in a broadcast channel (a group could go forever with zero replies to any given message). `owner_earning_credits` → the group owner's `earnings_pending`, converted immediately to `withdrawable_cash` at `credit_unit_kobo` — **the same two-step shape §9's peer-transfer already uses**, so the owner's cash-out inherits the existing KYC-gated, name-matched withdrawal path automatically, same reasoning as §9.
- `platform_take_credits` → the platform's `platform_revenue_earnings_cut` wallet, same as every other take-rate in this document.
- **Self-post exception is a hard requirement, not an optimization**: without it, a group owner messaging their own group nets a 70%-of-cost "discount" on their own reach, which is at least honest (they're still net-paying 30% to the platform) — but it's a strictly worse design than blocking it outright for zero benefit, since nothing legitimate is lost by requiring the owner to have someone else actually pay to reach them.
- New `pricing_config` key: `platform_group_message_take_bps`, default 3000 (30%) — independently tunable from `platform_earning_take_bps` (§5, 20%) and `platform_transfer_take_bps` (§9, 20%), per CLAUDE.md rule #9. Add to §8's revenue-summary table once built.
- Locking order (§3, generalizes to 3 wallets here): sender's `topup_credit`, owner's `earnings_pending` + `withdrawable_cash`, platform's revenue wallet — same fixed-ascending-wallet-id rule §9's `fn_transfer_credit` already established for a multi-user lock, skipping the owner-side locks entirely on a self-post (only one wallet touched then).

**Why this is gated behind Phase 5, not shipped the way §9's peer-transfer was:** this model has **no gating at all** on a non-self-post message — the owner earns 70% the instant _any_ other member sends _any_ message, unconditionally. Compare: §5's 1:1 escrow requires B to actually reply before anything releases; §9's peer-transfer requires knowing a real second person's phone number and is capped at `credit_transfer_max_credits` per transfer. Group billing has neither a reply-gate nor (as specified) a per-message or per-day cap — an attacker who creates a group and controls (or colludes with) just one other member can convert `topup_credit` into real withdrawable cash on every single message, indefinitely, with zero interaction required from "the owner" side beyond having created the group once. The self-post block above closes the single-account version of this; it does **not** close two colluding real accounts (owner + a funded alt/accomplice), which is exactly the collusion-graph/velocity-limit class of defense `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §1–8 builds for Phase 5. **Decision: hold this feature's real-money path behind that infra being live** — build and test it, but it does not go live for real users before Phase 5, same posture already applied to credit resale/gifting and referral bonuses in `docs/08-BUILD-PHASES-ROADMAP.md`'s deferred list (unlike §9's credit-transfer, which shipped ahead of its own gate on an explicit, separately-made call).

**Still unresolved before this actually goes live:** whether a per-group or per-day cap on `owner_earning_credits` is also warranted even after Phase 5 infra exists (§9 has `credit_transfer_max_credits` for exactly this reason — a per-message cap here would need its own default, likely mirroring `message_max_words`' 20-credit ceiling rather than a new number pulled from nowhere), group membership/admin model and a group-creation/invite flow (nothing writes `group_threads`/`group_members` outside tests yet), an Edge Function to expose `fn_send_group_message` to the app, and whether `docs/07-COMPLIANCE-LEGAL.md`'s money-transmission framing needs a second look given this is a _new_ N-party-adjacent money movement (one payer, one fixed payee per message, unlike §9's peer-to-peer which is already flagged there) — add this section to that document's pre-launch checklist when the feature is actually scheduled. Schema shape — see `docs/02-DATA-MODEL.md`'s corresponding note for why this uses new `group_threads`/`group_members`/`group_messages` tables rather than overloading the existing 1:1 `threads`/`messages`.

## 11. Reserve buffer + chargeback clawback (built 2026-09-15, session 14 — `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §3)

Every fee line in §8's revenue table is skimmed a second time before it lands: `platform_reserve_bps` (config, default 400 = 4%, within the 3–5% range §3 originally suggested) is held back into a rolling reserve wallet instead of the spendable revenue wallet — `platform_reserve_topup_fees` (kobo, mirrors `platform_revenue_topup_fees`) and `platform_reserve_earnings_cut` (credits, mirrors `platform_revenue_earnings_cut` — this one covers §8's earnings-take **and** peer-transfer-take rows both, same wallet either way). The split happens in the same transaction as the revenue credit itself, via a single shared function (`fn_credit_platform_revenue`) every revenue-crediting function calls — never a separate sweep job, never independent rounding on each side (the two pieces always sum to exactly the original amount).

This is pure self-insurance capital, not an earmarked fund against any specific incident — when a chargeback actually happens, `fn_process_chargeback` reverses the **full** original fee from the revenue wallet (not net-of-reserve), leaving the reserve wallet's accumulated skim untouched and growing. That's deliberate: the reserve's whole purpose is to be sitting there, unspent, precisely for moments the revenue wallet takes a hit — see `docs/02-DATA-MODEL.md` §5 for the full mechanism (`fn_credit_platform_revenue`/`fn_process_chargeback` signatures, what each debits/credits) and `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §3 for the fraud model this defends against.

A charged-back topup's payer ends up with a **negative** `topup_credit` balance — this app has no DB-level non-negative constraint on `wallets.balance`, so a debt is representable with zero schema change, exactly as intended: it's the tracked amount that user owes before their wallet is unfrozen, never silently written off.

## 12. Multi-currency (E2, scoped session 17 — schema/docs only, not yet built)

Scoped in `docs/10-UX-REFINEMENT-BACKLOG.md` Batch E's E2 item. `docs/07-COMPLIANCE-LEGAL.md`'s regulatory posture is written entirely against Nigeria/CBN today and says nothing about a second currency's money-transmission-licensing implications — per CLAUDE.md's own instruction, this ships ahead of legal review by **explicit user decision** ("full live multi-currency now"), the same "informed decision, built anyway, flagged for counsel" precedent already on record for §9's peer-to-peer transfer feature. Tracked as its own open item in `docs/07`'s checklist (§6), distinct from the existing Nigerian-licensing-posture item.

**Real Flutterwave capability, confirmed live against their current docs 2026-09-17 (not assumed):** this app's only collection method is the NGN dynamic virtual-account bank-transfer flow (`packages/payments/flutterwave.ts` — card collection is explicitly out of scope per this app's own "stay lite / no PCI scope" decision, `provider.ts`'s `CollectionResult` comment). Flutterwave's virtual-account product supports exactly **two currencies today: NGN and GHS** — and GHS collection requires a **separate merchant-activation request to Flutterwave** ("merchants outside Ghana need to request activation"), not something this project's live merchant account has been confirmed to have. Flutterwave's payout/transfer product covers far more countries/currencies (30+, including USD/EUR/GBP bank payout and mobile money), but a currency with payout support and no collection support is useless here — users need to top up in their own currency too, not just withdraw in it. **Net: NGN stays the only currency with a real end-to-end rail at launch. GHS is the only other currency with a real rail (still gated behind the Flutterwave activation request — an ops/business task, not a code task). Every other currency onboarding lets a user select shows the honest "not supported yet for payments — NGN only" fallback**, per the backlog doc's own anticipated design — the "full live multi-currency" decision means building the real infrastructure to add a currency the moment a rail exists for it, not pretending a rail exists where it doesn't.

**Target schema (see `docs/02-DATA-MODEL.md` §9 for the full column-level detail):**

- `pricing_config`'s primary key becomes `(key, currency)` — the user's own choice among the two options scoped (per-currency rows, not a single-NGN-source + FX-rate table) — every existing row backfilled `currency = 'NGN'`. Reading a price now requires the acting user's currency threaded through the call, not just the key.
- `users.country` (ISO 3166-1 alpha-2), `users.nickname`, `users.currency` (ISO 4217) — set once at onboarding (E2 spec item 5), immutable in practice thereafter (no "change your currency" flow exists or is scoped — a user's wallets/ledger are all denominated in the currency they signed up in).
- `wallets.currency` and `ledger_entries.currency` (ISO 4217) — every wallet/ledger row is now currency-tagged. Platform-owned wallets (`user_id is null`) go from unique-per-`kind` to unique-per-`(kind, currency)` — the platform now holds one revenue/reserve wallet **per currency**, never a single pooled figure summed across currencies, per CLAUDE.md rule #4: reconciliation must hold per-currency, and a job that summed NGN and GHS balances as if fungible would be a real, dangerous bug, not a rounding quirk.
- New `country_currency_config` table (country_code PK, currency, `payments_live` boolean) — the onboarding country picker's live source for which currency a country maps to and whether it's actually usable for payments today (config, not a hardcoded NGN/GHS check in app code, per CLAUDE.md rule #9). Seeded with every ISO country's real currency for display purposes, but `payments_live = true` only for `NG` at launch; `GH` flips to `true` only once the Flutterwave GHS activation request is actually confirmed granted (an ops step, tracked outside this repo).

**What this section does not cover:** the actual migration, the onboarding UI, and re-threading every `pricing_config` read-site to pass a currency — those are the next steps, tracked in this session's task list, built in that order (docs → migration → verify → UI) per this repo's own "plan the doc, then build to it" convention for schema work this size.
