# 09 — Project Structure

Monorepo, npm/pnpm workspaces. One Expo app, one Supabase backend folder, shared TypeScript packages for anything both sides need (mainly type definitions generated from the DB schema, and the `PaymentProvider` interface types).

```
InvolveMe/
├── apps/
│   └── mobile/                      # Expo app
│       ├── app/                     # expo-router file-based routes
│       │   ├── (auth)/              # OTP login/signup
│       │   ├── (tabs)/
│       │   │   ├── chats/
│       │   │   ├── status/
│       │   │   ├── wallet/          # InvolveMe-specific tab
│       │   │   └── calls/           # stubbed, see roadmap
│       │   ├── thread/[id].tsx
│       │   └── settings/
│       ├── components/
│       │   ├── chat/                # bubble, composer, escrow badge
│       │   ├── wallet/              # balance pill, countdown ring, tx row
│       │   └── ui/                  # buttons, sheets, skeletons — design-system primitives
│       ├── lib/
│       │   ├── supabase.ts          # client init (anon key only)
│       │   ├── queries/             # TanStack Query hooks per table/RPC
│       │   └── pricing.ts           # client-side cost PREVIEW only, mirrors pricing_config, never authoritative
│       ├── store/                   # Zustand slices (UI state only, never balances)
│       ├── theme/                   # design tokens from docs/04-DESIGN-SYSTEM.md
│       ├── motion/                  # shared Reanimated hooks/presets (credit-fly, pulse, odometer)
│       ├── app.config.ts
│       └── eas.json
│
├── supabase/
│   ├── migrations/                  # forward-only SQL, one file per change
│   ├── functions/                   # Edge Functions (Deno)
│   │   ├── send-message/
│   │   ├── buy-credit/
│   │   ├── withdraw/
│   │   ├── post-status/
│   │   ├── webhook-flutterwave/
│   │   ├── webhook-paystack/        # provisioned, inactive until enabled
│   │   ├── kyc-callback/
│   │   └── _shared/                 # auth helpers, pricing_config reader
│   ├── seed.sql                     # pricing_config defaults + test fixtures
│   └── config.toml
│
├── packages/
│   ├── payments/                    # PaymentProvider interface + Flutterwave/Paystack adapters
│   │   ├── provider.ts              # interface: collect(), payout(), verifyWebhook()
│   │   ├── flutterwave.ts
│   │   └── paystack.ts              # provisioned, not wired until PAYMENTS_ACTIVE_PROVIDER flips
│   ├── ledger-types/                # generated TS types from Postgres schema (supabase gen types)
│   └── config/                      # shared eslint/tsconfig/prettier
│
├── docs/                            # this blueprint
├── .github/workflows/               # CI: lint, typecheck, test, migrate-staging-on-merge
├── CLAUDE.md
├── README.md
├── LICENSE
├── .env.example
├── .gitignore
├── package.json                     # workspaces root
└── turbo.json                       # (or nx.json) task orchestration across apps/packages
```

## Conventions

- Anything under `apps/mobile` that needs a balance, cost, or fee number **imports it from a server response or `pricing_config` snapshot** — `lib/pricing.ts` exists only to render a cost *preview* while typing, and is explicitly documented in-file as non-authoritative, matching `CLAUDE.md` rule #1.
- New Edge Function → new folder under `supabase/functions/`, always paired with a test file exercising both the happy path and the concurrency/idempotency case per `CLAUDE.md`.
- New DB change → new file in `supabase/migrations/`, never edit an already-applied migration.
- Design tokens live in exactly one place (`apps/mobile/theme/`); components consume them, never redefine colors/spacing locally.
