# InvolveMe

**Get paid for your time, one conversation at a time.**

InvolveMe is a cross-platform mobile chat app modeled on WhatsApp's UX (1:1 chat, status/stories, groups, calls) with one structural difference: conversations are **pay-per-message**. Anyone who wants to chat with someone else buys **Chat Credit**, and the person they're messaging earns real cash for their time as they reply. InvolveMe takes a cut on both the top-up and the earning side.

This repo's `docs/` folder is the full engineering blueprint. **Start with [`docs/00-SESSION-HANDOFF.md`](docs/00-SESSION-HANDOFF.md)** — it's the living "what's actually true right now" snapshot; the rest of the docs describe the target design. Then read in this order:

| #   | Doc                                                                          | Covers                                                           |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | [`docs/01-ARCHITECTURE.md`](docs/01-ARCHITECTURE.md)                         | System architecture, tech stack, why each piece was chosen       |
| 2   | [`docs/02-DATA-MODEL.md`](docs/02-DATA-MODEL.md)                             | Postgres schema, ledger tables, RLS strategy                     |
| 3   | [`docs/03-ECONOMY-LEDGER.md`](docs/03-ECONOMY-LEDGER.md)                     | Credit pricing, fee math, escrow/earning flow, withdrawal rules  |
| 4   | [`docs/04-DESIGN-SYSTEM.md`](docs/04-DESIGN-SYSTEM.md)                       | Visual identity, tokens, motion/animation spec, component states |
| 5   | [`docs/05-API-REALTIME-SPEC.md`](docs/05-API-REALTIME-SPEC.md)               | Edge Function contracts, realtime channels, sequence diagrams    |
| 6   | [`docs/06-SECURITY-FRAUD-LOOPHOLES.md`](docs/06-SECURITY-FRAUD-LOOPHOLES.md) | Every abuse vector identified (now + future) and its mitigation  |
| 7   | [`docs/07-COMPLIANCE-LEGAL.md`](docs/07-COMPLIANCE-LEGAL.md)                 | KYC/AML, CBN/money-transmission exposure, app store policy risk  |
| 8   | [`docs/08-BUILD-PHASES-ROADMAP.md`](docs/08-BUILD-PHASES-ROADMAP.md)         | Phased delivery plan, team shape, milestones                     |
| 9   | [`docs/09-PROJECT-STRUCTURE.md`](docs/09-PROJECT-STRUCTURE.md)               | Repo/folder layout for the Expo app + Supabase backend           |

`CLAUDE.md` is the standing brief for any AI coding agent (or new engineer) working in this repo — read it before writing code.

## Stack at a glance

- **Client:** React Native (Expo, managed → bare when needed), TypeScript, Reanimated 3 + Moti for motion, Zustand + TanStack Query for state.
- **Backend:** Supabase (Postgres, Auth, Realtime, Storage) + Supabase Edge Functions (Deno/TypeScript) for every money-moving operation. No financial logic ever runs client-side.
- **Payments/Payouts:** Flutterwave first (Collections + Transfers), built behind a `PaymentProvider` interface so Paystack (or others) can be added later without touching business logic.
- **Currency:** NGN, tracked in kobo (integers) everywhere — no floats near money.

## ⚠️ Read this before building the economics as literally specified

The brief's raw pricing rules have a genuine **loophole** (message-length gaming) and a **margin problem** (the 2% deposit fee is likely smaller than the payment gateway's own processing fee, meaning InvolveMe could lose money on every top-up before it even takes its 20% cut). Both are called out with fixes in `docs/03-ECONOMY-LEDGER.md` and `docs/06-SECURITY-FRAUD-LOOPHOLES.md` — implement the **hardened** version described there, not the literal flat-rate wording, unless you've re-run the unit economics yourself.

## Status

**Phase 0 (foundations) in progress** — see `docs/08-BUILD-PHASES-ROADMAP.md`. Monorepo scaffold, design tokens, navigation shell, and phone/OTP auth wiring live in `apps/mobile/`; no wallet, chat, or payment logic exists yet on purpose.

## Getting started

```
npm install
cp .env.example apps/mobile/.env   # then fill in your dev Supabase project values
npm run dev
```

See `apps/mobile/README.md` for app-specific detail.

## License

Proprietary — see [`LICENSE`](LICENSE). This is not an open-source project.
