# 04 — Design System

Goal: WhatsApp-familiar information architecture (chat list → thread → status → calls tabs), but a distinct, premium visual identity that signals "your time has value" — money/credit is a first-class visual citizen, not an afterthought bolted onto a green chat theme.

## 1. Brand palette

**Rebranded 2026-09-13 ("Deep Wine")** — replaces the violet+gold ("Involve Violet") direction described below. Shipped from an exact-hex design brief + mockup (wine `#5F1B31` / milk `#FFE6D8` / cream canvas `#FBF9F1`); the brief specified light-mode values only, so the dark column below is a conservative extrapolation (same wine/milk hues ported onto dark canvases, brand hue lightened for contrast), not a second designed look — revisit if a real dark-mode mock ever exists. `inverse`/`badge` tokens deliberately **don't vary by theme**: the bottom tab bar and unread badges are a solid wine surface with cream content regardless of app theme (see `tabBarStyle` in `(tabs)/_layout.tsx`).

Tokens, not hardcoded hex in components.

| Token                        | Light   | Dark    | Use                                                                                    |
| ---------------------------- | ------- | ------- | -------------------------------------------------------------------------------------- |
| `color.bg.canvas`            | #FBF9F1 | #1A1013 | app background                                                                         |
| `color.bg.surface`           | #FFFFFF | #241820 | cards, sheets, bubbles (incoming)                                                      |
| `color.bg.surfaceAlt`        | #FFE6D8 | #3A2430 | input bar, list rows, search-bar fill                                                  |
| `color.brand.primary`        | #5F1B31 | #C97D91 | primary actions, sender bubble, active tab, header icons — "Deep Wine"                 |
| `color.brand.primaryPressed` | #45131F | #B5677B | pressed state; also the active bottom-tab pill fill                                    |
| `color.accent.credit`        | #F5A623 | #FFC24D | credit/currency accents — balance chips, coin iconography, earning highlights          |
| `color.semantic.success`     | #12B76A | #32D583 | earnings received, delivered, KYC verified                                             |
| `color.semantic.danger`      | #F04438 | #F97066 | low balance, failed payment, blocked                                                   |
| `color.semantic.warning`     | #F79009 | #FDB022 | pending withdrawal, escrow pending                                                     |
| `color.text.primary`         | #000000 | #F5EDE9 | header title, primary body copy                                                        |
| `color.text.secondary`       | #5F1B31 | #E7A9BA | chat display names, active sub-tab indicator                                           |
| `color.text.tertiary`        | #8A8A8A | #A8A29E | message previews, timestamps                                                           |
| `color.text.inverse`         | #FFE6D8 | #FFE6D8 | bottom-nav labels/icons, primary-button label, search-bar text — theme-fixed           |
| `color.badge.bg`             | #5F1B31 | #5F1B31 | unread-counter badge fill (not yet consumed — no real unread data exists, see roadmap) |
| `color.badge.text`           | #FFE6D8 | #FFE6D8 | unread-counter badge label                                                             |
| `color.border.subtle`        | #EAD9CD | #3A2A30 |                                                                                        |

Rationale: wine+milk-on-cream reads as warm/premium and is deliberately distinct from WhatsApp/Telegram green-and-blue so InvolveMe doesn't read as a clone at a glance. Gold (`accent.credit`, unchanged by this rebrand) stays the one color reused everywhere money/credit appears, so that association isn't muddied by also sitting close to the new brand wine.

## 2. Typography

System font stack only — **no bundled custom font family** for body text, to protect the "lite" bundle-size budget: `-apple-system`/San Francisco on iOS, Roboto on Android (React Native default resolves this automatically). One exception: numerals in balance displays use **tabular figures** (`fontVariant: ['tabular-nums']`) so credit/cash counters don't jitter in width as digits animate.

| Style         | Size / Weight           | Use                                                                                                                                                                                   |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brand`       | 30 / 800, +0.2 tracking | The "InvolveMe" wordmark in the Chats tab header only — heavier than `display` on purpose, so the one place the brand name appears reads as a wordmark, not just another screen title |
| `display`     | 28 / 700                | Onboarding, empty states, non-brand screen headers (Status/Wallet)                                                                                                                    |
| `title`       | 20 / 600                | Screen headers, thread name                                                                                                                                                           |
| `body`        | 16 / 400                | Message text                                                                                                                                                                          |
| `bodyMedium`  | 16 / 500                | Sender name, list titles                                                                                                                                                              |
| `caption`     | 13 / 400                | Timestamps, word/credit-cost preview                                                                                                                                                  |
| `balance`     | 24 / 700, tabular-nums  | Wallet balance headline                                                                                                                                                               |
| `tabBarLabel` | 12 / 700                | Bottom tab bar labels — bolder than React Navigation's ~11/500 default, added 2026-09-13 per the header/nav overhaul (see docs/00-SESSION-HANDOFF.md)                                 |

**Header/tab-bar treatment (added 2026-09-13, colors updated same day for the Deep Wine rebrand):** every `(tabs)` screen renders exactly one header via the shared `components/ui/AppHeader.tsx` — the Chats tab uses `brand`/color `brand` for "InvolveMe"; Status and Wallet use plain `display`/`primary`, matching their pre-existing look. `AppHeader` also owns the three-dot overflow menu (Settings lives there now, off the Chats header's main row) and an optional persistent `rightSlot` action (Chats' "+"), spaced `spacing.xl` (~24dp) apart per the rebrand's header spec. The bottom tab bar is now a solid `brand.primary` (wine) surface with `text.inverse` (milk) labels/icons in both active and inactive states, the active tab additionally getting a `brand.primaryPressed` pill behind its icon; order is Chats / Calls / Wallet / Status (previously Chats / Status / Wallet / Calls). Icons are still a bold single glyph per tab (💬/📞/👛/🛠) rendered through the existing `Text` primitive — no vector-icon package is in this project yet, and adding one wasn't judged worth a new dependency for this alone; revisit with `@expo/vector-icons` (ships inside the Expo SDK, would need an explicit install in this monorepo) if real iconography is wanted later.

**Chats tab structure (added 2026-09-13):** below `AppHeader`, a fixed Chats/Groups/Contacts segmented sub-header (`color.text.secondary` label + a `brand.primary` underline on the active tab) — only "Chats" is a real feature, Groups and Contacts are honest stubs (same pattern as the Calls tab) pending the group-chat design pass in `docs/03-ECONOMY-LEDGER.md` §10. The search bar lives inside the scrollable thread list (its `ListHeaderComponent`, so it scrolls away with the list) rather than in the fixed header, filled `brand.primary` with `text.inverse` placeholder/icon/text. Each thread row shows a real timestamp, real last-message preview (`color.text.tertiary`), and — added 2026-09-14 — a real unread-count pill (`color.badge.bg`/`color.badge.text`, right-aligned under the timestamp) once `thread_unread_counts` reports a nonzero count for that thread; see `docs/00-SESSION-HANDOFF.md` and `docs/02-DATA-MODEL.md`'s `threads` section for the read-cursor mechanics behind it. The Chats bottom-tab icon carries the same total as a native `tabBarBadge`.

## 3. Spacing, radius, elevation

- 4px base grid: `space.xs=4, sm=8, md=12, lg=16, xl=24, xxl=32`.
- Radius: `radius.bubble=18, radius.card=16, radius.sheet=24 (top corners), radius.pill=999`.
- Elevation via soft, tinted shadows (violet-tinted in light mode, none/border in dark mode — pure black shadows on a near-black background are wasted), 3 levels only (`elevation.1/2/3`) to keep the shadow system simple.

## 4. Motion system

Built on **Reanimated 3** (UI-thread animations) + **Moti** for declarative wrappers, plus `react-native-gesture-handler` for gesture-driven interactions. Motion has a job in this app beyond delight: it must make the **money mechanics legible** — a credit debit, an escrow hold, an earning release should each _feel_ distinct.

| Interaction                     | Motion spec                                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Message send                    | Bubble scales in from 0.8→1 with a spring (`damping: 15, stiffness: 180`), sends on a slight upward slide (mirrors WhatsApp's familiar feel)                                                                                        |
| **Credit debit on send**        | The cost chip (e.g. "−2") flies from the input bar to the balance pill in the header and the balance pill number rolls down (odometer-style digit roll) — makes "this message just cost you money" viscerally clear without a modal |
| **Escrow pending**              | Sent bubble shows a subtle pulsing amber dot/outline (`opacity 0.4↔1, 1.6s loop`) until B replies — communicates "held, not yet earned" at a glance                                                                                 |
| **Earning received (B's side)** | Balance pill flashes gold, a small "+N credits" toast rises and fades with a light haptic (`ImpactFeedbackStyle.Light`); on first earning ever, a one-time confetti burst (small, ≤ 400 particles, GPU-cheap)                       |
| Pull-to-refresh (chat list)     | Custom spring-based rubber-banding, not the default OS spinner — replaced with the brand mark subtly rotating                                                                                                                       |
| Swipe-to-reply                  | 1:1 finger tracking via gesture-handler, snap-back spring if released before threshold (mirrors WhatsApp)                                                                                                                           |
| Screen transitions              | Native-stack shared-element transition: tapping a chat-list row morphs the avatar+name into the thread header position (`react-navigation` shared element or `react-native-screens` native transitions)                             |
| Status ring                     | Animated gradient ring (violet→gold conic gradient) around avatars with unseen status, using `react-native-svg` + Reanimated-driven `strokeDashoffset`, not a GIF/Lottie                                                            |
| Low-balance warning             | Input bar border animates to `color.semantic.danger` with a short shake (3× 4px horizontal, 250ms) when a message would exceed available balance, before the send even attempts server-side                                         |
| Withdrawal countdown            | The 24h auto-withdraw timer on the earnings screen is a thin circular progress ring that visibly drains — reinforces the "use it or it auto-withdraws" mechanic without needing copy to explain it                                  |
| Skeletons                       | Shimmer skeletons (Reanimated `interpolate` on a translateX gradient) for chat list / thread load, not spinners                                                                                                                     |

Performance rule: every animation must be expressible as a `useAnimatedStyle` driven by a shared value updated on the UI thread; no `setState`-per-frame animations, ever — this is what keeps 60fps on low/mid-tier Android devices while staying "lite."

## 5. Core screens (WhatsApp-parity IA)

1. **Chats** (tab) — list, swipe actions (archive/mute/delete), balance pill in header.
2. **Status** (tab) — ring feed, camera-first composer, credit cost shown before posting.
3. **Wallet** (new tab, InvolveMe-specific — this is the structural addition to the WhatsApp IA) — `topup_credit` balance, `earnings_pending`, `withdrawable_cash` with the countdown ring, "Top Up" and "Withdraw" primary actions, transaction history (rendered straight from `ledger_entries`, user-facing labels mapped from `reason`).
4. **Calls** (tab) — parity feature, out of v1 scope (see roadmap), voice/video calls are **not** part of the pay-per-message credit system in v1 to keep scope bounded — flagged as a future monetization/complexity decision, not an oversight.
5. **Thread** — bubbles, per-message cost shown as a small caption under each bubble (`"2 credits"` / `"4 credits · 63 words"`) so cost is never hidden, composer shows live word-count → credit-cost preview as you type.
6. Profile/Settings — KYC status badge prominently surfaced (verified/unverified), bank account management, standard WhatsApp-parity privacy controls.

## 6. Accessibility

- All color pairs meet WCAG AA contrast in both themes (validate `color.accent.credit` on `color.bg.surface` specifically — gold-on-white is the riskiest pair in this palette; use the darker `#B87700` text-only variant if literal amber fails contrast in light mode).
- Every motion above has a reduced-motion fallback (`useReducedMotion()` from Reanimated) — cross-fades replace springs/parallax, countdown rings still show but without the pulse.
- Minimum tap target 44×44pt throughout, standard for both platforms.
