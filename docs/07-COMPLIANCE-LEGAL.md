# 07 — Compliance & Legal Posture

**This document is engineering-facing risk-awareness, not legal advice.** Get actual Nigerian fintech/telecom counsel before public launch — the items below are what to bring to that conversation, and what to design the system around in the meantime so launch isn't blocked on a rebuild.

## 1. Money transmission / CBN exposure

InvolveMe holds user funds (top-up balances, pending earnings) and moves cash between unrelated third parties based on in-app activity. That is functionally a **wallet + peer-to-peer payout service**, which in Nigeria sits near activities the CBN regulates (Payment Service Bank / Mobile Money Operator / Switching licenses, guidelines for MFBs and PSPs).

**Design mitigation already baked in:** InvolveMe never directly touches bank rails or holds settlement funds outside a licensed processor — Flutterwave (and later Paystack) are themselves licensed payment service providers, and all collections/payouts route through them. InvolveMe's Postgres ledger tracks **entitlement** (who is owed what), not custody of cash outside the regulated processor's settlement account. This is the standard "wallet-on-top-of-a-licensed-PSP" pattern many Nigerian apps use, but it does not automatically make InvolveMe exempt from needing its own licensing as usage scales — confirm with counsel at what transaction volume / feature set (e.g., allowing wallet-to-wallet transfer without an underlying chat trigger) would cross into needing InvolveMe's own PSP or MFB license.

**Do not build, without a legal check first:** direct wallet-to-wallet cash transfer unconnected to chat activity, credit resale/exchange between users, or anything resembling a stored-value instrument usable outside the app (e.g., a redeemable gift-card-like credit) — each of those meaningfully changes the regulatory analysis.

## 2. KYC/AML

- **Tiered KYC is mandatory before any cash leaves the system** (see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §4): Tier 1 = BVN or NIN verification via a licensed KYC vendor (e.g., a provider integrated with NIMC/CBN watchlists — do not build custom BVN verification, use a vendor with the proper data-sharing agreements). Tier 2 = liveness/enhanced verification for higher limits.
- **Sanctions/watchlist screening** on KYC completion (most Nigerian KYC vendors bundle this) — block or flag matches, do not silently allow.
- **Suspicious Activity Reporting posture**: the `fraud_signals` table and admin review queue (§2/§6 of the loopholes doc) exist specifically so that if a formal SAR obligation applies to InvolveM at its licensing tier, the operational muscle to detect and log suspicious patterns already exists rather than needing to be built under regulatory pressure.
- **Record retention**: KYC records and transaction ledger entries are retained per whatever the applicable regulation requires (commonly 5 years in AML frameworks) — do not build a data-retention/deletion policy that purges `ledger_entries` or `kyc_records` on user account deletion; anonymize the user profile but retain the financial trail.

## 3. App Store / Play Store policy risk

This is the most immediate practical risk — the app can be built perfectly and still get rejected or pulled.

- **Apple App Store Review Guidelines** scrutinize apps that facilitate paid interaction between strangers, especially anything read as adjacent to escort/companion services, and apps that move real money must generally use approved payment flows for digital goods vs. real-world services correctly classified (chat-for-pay is a "service," not digital content, so Apple's in-app-purchase requirement for digital goods should *not* apply — but this exact classification is a common review flashpoint and needs explicit justification in the review notes, and ideally a pre-submission consultation).
- **Google Play** has similar policies around monetized social/dating-adjacent interaction and financial services (Play's Financial Services policy applies to apps facilitating money transmission).
- **Mitigation baked into product design:** no explicit/adult content, mandatory content moderation (text scanning for harassment/solicitation, image moderation on media/status uploads), clear ToS prohibiting use of the platform for sexual services or solicitation, an in-app reporting/blocking system (WhatsApp-parity feature, also a review requirement), and age verification (18+) at signup given money changes hands. Build all of this before submission — retrofitting moderation after a rejection or takedown is far more expensive than shipping it in v1.

## 4. Terms of Service must explicitly cover

- Chat credit is **not** a currency, gift card, or transferable financial instrument outside the app's defined mechanics — it has no value except as defined by the pricing config, to avoid it being treated as a separate regulated stored-value product.
- Platform's fee structure (2% top-up, 20% earnings take) disclosed plainly, not just in fine print — regulators and app stores both look for this.
- Escrow/refund mechanics (unanswered-message refund window) disclosed so users understand when they are and aren't charged.
- Withdrawal eligibility conditions (KYC requirement, tiered limits, the 24h promise's actual conditions per `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §4) — do not market an unconditional "24h guaranteed" if the real system is tiered; market it accurately as "for verified users."
- Prohibited use policy (solicitation, harassment, fraud, multi-accounting) with clear grounds for suspension/fund freezing, referencing the `is_frozen`/`is_suspended` mechanisms that actually exist in the system.

## 5. Data protection

Nigeria Data Protection Act (NDPA) applies: lawful basis for processing phone numbers, BVN/NIN (highly sensitive — store only a vendor-provided verification token/hash, never raw BVN, per `kyc_records.bvn_or_nin_hash` in the data model), and message content. Message bodies should be encrypted at rest (Postgres column-level or Supabase's at-rest encryption) at minimum; end-to-end encryption is a larger lift explicitly deferred — see roadmap — but must be disclosed honestly in the privacy policy either way (don't imply E2EE, WhatsApp-style, unless it's actually built).

## 6. Pre-launch legal checklist

- [ ] Confirm InvolveMe's licensing posture with Nigerian fintech counsel given the "wallet on top of a licensed PSP" architecture
- [ ] KYC vendor contract with proper BVN/NIN data-sharing agreement in place
- [ ] ToS + Privacy Policy drafted covering §4/§5 above, reviewed by counsel
- [ ] Content moderation pipeline live before app store submission
- [ ] Age gate (18+) enforced at signup
- [ ] Pre-submission review notes prepared for Apple explaining the pay-per-message service model
- [ ] Reserve buffer / chargeback-handling process agreed with Flutterwave account manager
