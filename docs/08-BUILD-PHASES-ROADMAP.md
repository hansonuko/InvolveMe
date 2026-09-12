# 08 — Build Phases & Roadmap

Small team assumption: 1 product/founder, 2 mobile engineers (RN), 1 backend/Postgres-focused engineer, 1 designer (part-time ok given the design system is already spec'd), 1 QA/fraud-ops (can be part-time/founder-covered early). Adjust timelines proportionally if the team is smaller.

## Phase 0 — Foundations (1–2 weeks)
- Repo scaffold per `docs/09-PROJECT-STRUCTURE.md`, CI pipeline, environments (dev/staging/prod Supabase projects + Flutterwave test keys).
- Design tokens implemented as a theme provider (`docs/04-DESIGN-SYSTEM.md`).
- Auth: phone OTP via Supabase Auth.
- **Exit criteria:** empty app boots on both platforms, OTP login works, CI green.

## Phase 1 — Core ledger & wallet plumbing (2–3 weeks, highest-risk phase — do not rush)
- Full schema from `docs/02-DATA-MODEL.md`, migrations, RLS policies.
- `fn_send_message`, `fn_release_escrow`, `fn_buy_credit`/`fn_confirm_topup`, `fn_initiate_withdrawal` — with the concurrency/locking tests mandated in `CLAUDE.md`.
- `pricing_config` table + admin read path.
- Reconciliation cron live from day one, even before there's real money, so it's battle-tested.
- **Exit criteria:** a scripted integration test can simulate 100 concurrent sends against one wallet and the ledger reconciles to the kobo/credit every time.

## Phase 2 — Chat MVP (2–3 weeks)
- Thread list, thread view, send/receive via `send-message` Edge Function, Realtime message delivery.
- Escrow-pending visual state, word-count → cost preview, low-balance blocking.
- Basic block/report (needed for app-store review regardless of when monetization ships).
- **Exit criteria:** two test accounts can hold a full paid conversation end-to-end with correct escrow/release behavior, matching the worked examples in `docs/03-ECONOMY-LEDGER.md`.

## Phase 3 — Payments in, payments out (2–3 weeks)
- Flutterwave Collections integration (`buy-credit` + webhook, signature verification, idempotency).
- KYC vendor integration (Tier 1: BVN/NIN).
- Bank account linking + name-match verification.
- Flutterwave Transfers integration (`withdraw`), manual withdrawal only at first (auto-sweep held for Phase 5 until fraud controls land).
- **Exit criteria:** a real (sandbox) top-up → chat → earn → manual withdraw loop works end-to-end against Flutterwave's test environment.

## Phase 4 — Motion & polish pass (1–2 weeks, can overlap Phase 3)
- Full `docs/04-DESIGN-SYSTEM.md` motion spec implemented (credit-fly animation, escrow pulse, earning flash, skeletons, shared-element transitions).
- Performance pass against the "lite" budgets in `docs/01-ARCHITECTURE.md` §5 (bundle size, cold start) — treat any budget miss as a blocking bug here, not something to defer.
- **Exit criteria:** budgets met on a real mid-tier Android device, not just a simulator.

## Phase 5 — Fraud & compliance hardening (2–3 weeks — do not launch publicly without this)
- Device fingerprinting, collusion graph job, velocity limits, duplicate-content detection (`docs/06-SECURITY-FRAUD-LOOPHOLES.md` §1–8).
- Tiered withdrawal limits + auto-withdraw sweep turned on.
- Content moderation pipeline (text + media) for app-store compliance.
- Admin review queue / kill-switch tooling (freeze wallet, suspend user).
- **Exit criteria:** every item in the loopholes doc's §12 checklist is either shipped or explicitly deferred with a written reason and owner.

## Phase 6 — Status updates + wallet screen polish (1 week)
- Status upload with credit debit, 24h expiry, ring UI.
- Wallet tab: full transaction history rendered from `ledger_entries`, withdrawal countdown ring.

## Phase 7 — Closed beta → app store submission (2–3 weeks, includes review turnaround buffer)
- Legal checklist from `docs/07-COMPLIANCE-LEGAL.md` §6 fully closed.
- Closed beta with real (small) money, reserve buffer funded, on-call rotation for the reconciliation alerts.
- Store submissions with review notes prepared explaining the pay-per-message model.

## Explicitly deferred out of v1 (revisit as roadmap items, not oversights)
- Voice/video calls (WhatsApp-parity feature, no monetization model defined for it yet — decide whether calls are also pay-per-minute before building, don't bolt it on later without re-running the economics).
- Group chats (credit-splitting/multi-payer logic across a group is a materially different ledger design from 1:1 escrow — worth its own design pass, not a quick extension).
- End-to-end encryption of message content (see compliance doc §5 — ship honest privacy copy in the meantime).
- Credit resale/gifting between users, referral bonuses (blocked on the fraud infra in Phase 5 existing first, per loopholes doc §10).
- Multi-currency support (architecture is currency-agnostic at the type level, but pricing_config and Flutterwave integration are NGN-first; don't assume this is free to add later).
- Paystack activation (interface is provisioned from day one per `docs/01-ARCHITECTURE.md`; flip `PAYMENTS_ACTIVE_PROVIDER` when needed, budget a short integration/testing pass, not zero effort).

## Suggested milestone order recap

Phase 0 → 1 → 2 → 3 → 4 (parallel with 3) → 5 → 6 → 7. Total: roughly 12–18 weeks to a compliant public launch with a small team, weighted heavily toward Phase 1 and Phase 5 being done properly rather than rushed — those two are where a wallet product actually lives or dies.
