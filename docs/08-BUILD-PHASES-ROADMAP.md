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
- ~~Basic block/report~~ — **built 2026-09-14** (needed for app-store review regardless of when monetization ships). See `docs/02-DATA-MODEL.md`'s `threads.blocked_by`/`user_reports` notes.
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

Re-audited 2026-09-15 (session 13) against actual code, not assumption — see `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §12 for the item-by-item status this list summarizes.

- ~~Device fingerprinting, collusion graph job, velocity limits~~ — **built 2026-09-15**: `device_fingerprints`/`fn_link_device_fingerprint`, `fn_run_collusion_detection` (nightly, two signal types, manual-review-only — never auto-freezes), `new_account_daily_topup_cap_kobo`. Mobile capture built but **not yet shipped** — needs a real `eas build` (new native modules, not OTA-eligible), held at the user's request until more work accumulates to build together.
- Duplicate-content detection (`docs/06-SECURITY-FRAUD-LOOPHOLES.md` §6) — **still not built**, explicitly deferred out of the 2026-09-15 pass (a distinct problem — chat-farming — from the self-dealing/wash-chatting §2 that pass targeted). Rate limiting on message send is bundled into this same still-open item.
- ~~Tiered withdrawal limits + auto-withdraw sweep turned on~~ — **done since Phase 1**, not Phase 5 work as this list implied (`kyc_tier1_daily_withdrawal_cap_kobo`, `fn_run_auto_withdraw_sweep`). This bullet was stale.
- Content moderation pipeline (text + media) for app-store compliance — **still not built**, and still blocked on there being no media pipeline in this app at all yet.
- ~~Admin review queue / kill-switch tooling~~ — **no dedicated tooling exists or is planned**; the actual answer, confirmed this session, is Supabase Studio directly against `fraud_signals`/`is_frozen` — same as `docs/01-ARCHITECTURE.md`'s original "admin dashboarding via Supabase Studio" call. Worth revisiting only if that genuinely stops being workable at real volume, not before.
- Gate for turning on group-chat billing (`docs/03-ECONOMY-LEDGER.md` §10) — **partially satisfied**, not fully: collusion detection + velocity limits now exist, but §10's own stated risk (group chat has no reply-gate or per-message cap) is really answered by the still-unbuilt duplicate-content/rate-limiting item above, not by what shipped 2026-09-15. Do not flip `group_chat_enabled` on this basis alone.
- **Exit criteria:** every item in the loopholes doc's §12 checklist is either shipped or explicitly deferred with a written reason and owner. Current real status: 9 of 11 checked (§3's reserve-buffer/clawback closed 2026-09-15 session 14), two genuinely open — §10's referral-system prerequisites (fingerprinting/velocity limits exist, OTP/carrier-detection doesn't) and §11's legal sign-off, which needs actual counsel, not more building.

## Phase 6 — Status updates + wallet screen polish (1 week)

- Status upload with credit debit, 24h expiry, ring UI.
- Wallet tab: full transaction history rendered from `ledger_entries`, withdrawal countdown ring.

## Phase 7 — Closed beta → app store submission (2–3 weeks, includes review turnaround buffer)

- Legal checklist from `docs/07-COMPLIANCE-LEGAL.md` §6 fully closed.
- Closed beta with real (small) money, reserve buffer funded, on-call rotation for the reconciliation alerts.
- Store submissions with review notes prepared explaining the pay-per-message model.

## Explicitly deferred out of v1 (revisit as roadmap items, not oversights)

- Voice/video calls (WhatsApp-parity feature, no monetization model defined for it yet — decide whether calls are also pay-per-minute before building, don't bolt it on later without re-running the economics).
- Group chats (credit-splitting/multi-payer logic across a group is a materially different ledger design from 1:1 escrow — worth its own design pass, not a quick extension). **Design pass done, billing model decided 2026-09-13** — see `docs/03-ECONOMY-LEDGER.md` §10 (sender pays the normal per-message cost, 70% to the group owner / 30% platform, settled immediately with no escrow — self-posts by the owner don't earn) and `docs/02-DATA-MODEL.md`'s "Group threads — scoping" note (proposed schema). **Explicitly held behind Phase 5**, same as the line below — this model has no reply-gate and no per-message cap, so two colluding accounts (owner + one funded alt) can convert credit to cash on every message with zero interaction beyond creating the group once; do not flip it live before the collusion-detection/velocity-limit infra below exists, even once it's built and tested.
- ~~Unread counts / per-thread read-cursor tracking~~ — **built 2026-09-14.** Surfaced 2026-09-13 when a design mockup assumed this existed (`threads` had no per-participant "last read" cursor at the time); now does. See migration `20260914080000_thread_read_cursor.sql` and `docs/00-SESSION-HANDOFF.md`. Presence/typing indicators and broadcast read-receipts (`docs/05-API-REALTIME-SPEC.md` §3) remain separately deferred — this is only the "how many unread" piece, not live typing/presence.
- End-to-end encryption of message content (see compliance doc §5 — ship honest privacy copy in the meantime).
- Credit resale/gifting between users, referral bonuses (blocked on the fraud infra in Phase 5 existing first, per loopholes doc §10).
- Multi-currency support (architecture is currency-agnostic at the type level, but pricing_config and Flutterwave integration are NGN-first; don't assume this is free to add later).
- Paystack activation (interface is provisioned from day one per `docs/01-ARCHITECTURE.md`; flip `PAYMENTS_ACTIVE_PROVIDER` when needed, budget a short integration/testing pass, not zero effort).

## Suggested milestone order recap

Phase 0 → 1 → 2 → 3 → 4 (parallel with 3) → 5 → 6 → 7. Total: roughly 12–18 weeks to a compliant public launch with a small team, weighted heavily toward Phase 1 and Phase 5 being done properly rather than rushed — those two are where a wallet product actually lives or dies.
