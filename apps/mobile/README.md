# InvolveMe — mobile app

Expo (SDK 57) + TypeScript. See the root [`README.md`](../../README.md) and
[`CLAUDE.md`](../../CLAUDE.md) for the product/architecture blueprint before
working in here — this folder is the client only; no financial logic belongs
in it (see `CLAUDE.md` rule #1).

## Setup

1. Copy the repo-root `.env.example` to `apps/mobile/.env` (Expo's CLI loads
   `.env` from the Expo project root, not the monorepo root) and fill in your
   dev Supabase project's `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`.
   Without these, the app boots but auth calls will fail (a console warning
   says so on start).
2. From the repo root: `npm install`
3. `npm run dev` (or `cd apps/mobile && npm start`)

## Structure

See `docs/09-PROJECT-STRUCTURE.md` at the repo root for the full layout
rationale. Quick map:

| Folder                                   | What goes here                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `app/`                                   | expo-router routes: `(auth)`, `(tabs)`, `thread/[id]`, `settings`                |
| `theme/`                                 | Design tokens + `ThemeProvider` — the only place colors/spacing/type are defined |
| `components/ui/`                         | Themed primitives (`Text`, `Button`, `Screen`)                                   |
| `components/chat/`, `components/wallet/` | Feature components — empty until Phase 2/3                                       |
| `lib/`                                   | Supabase client, hooks (`useSession`)                                            |
| `store/`                                 | Zustand — UI-only state, never server/balance state                              |
| `motion/`                                | Reanimated presets — placeholder until Phase 4                                   |

## Current status

Phase 0 (foundations): navigation shell + phone/OTP auth wired against
Supabase. No chat, wallet, or payment functionality yet — see
`docs/08-BUILD-PHASES-ROADMAP.md` for what's next.
