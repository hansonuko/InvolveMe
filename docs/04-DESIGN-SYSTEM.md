# 04 — Design System

Goal: WhatsApp-familiar information architecture (chat list → thread → status → calls tabs), but a distinct, premium visual identity that signals "your time has value" — money/credit is a first-class visual citizen, not an afterthought bolted onto a green chat theme.

## 1. Brand palette

Dark-first (chat apps skew dark-mode by default now), full light mode supported. Tokens, not hardcoded hex in components.

| Token | Light | Dark | Use |
|---|---|---|---|
| `color.bg.canvas` | #FAFAFC | #0B0B10 | app background |
| `color.bg.surface` | #FFFFFF | #16161D | cards, sheets, bubbles (incoming) |
| `color.bg.surfaceAlt` | #F1F0F7 | #1E1E28 | input bar, list rows |
| `color.brand.primary` | #5B3DF5 | #7C5CFF | primary actions, sender bubble, active tab — "Involve Violet" |
| `color.brand.primaryPressed` | #4527D6 | #6A4AE8 | pressed state |
| `color.accent.credit` | #F5A623 | #FFC24D | credit/currency accents — balance chips, coin iconography, earning highlights |
| `color.semantic.success` | #12B76A | #32D583 | earnings received, delivered, KYC verified |
| `color.semantic.danger` | #F04438 | #F97066 | low balance, failed payment, blocked |
| `color.semantic.warning` | #F79009 | #FDB022 | pending withdrawal, escrow pending |
| `color.text.primary` | #14131F | #F2F1F8 | |
| `color.text.secondary` | #6B6879 | #A7A4B8 | timestamps, metadata |
| `color.border.subtle` | #E7E5F0 | #2A2A35 | |

Rationale: violet+gold reads as "premium fintech-meets-messaging" and is deliberately distinct from WhatsApp/Telegram green-and-blue so InvolveMe doesn't read as a clone at a glance, while gold specifically is reused everywhere money/credit appears so users build a fast visual association ("gold = my value").

## 2. Typography

System font stack only — **no bundled custom font family** for body text, to protect the "lite" bundle-size budget: `-apple-system`/San Francisco on iOS, Roboto on Android (React Native default resolves this automatically). One exception: numerals in balance displays use **tabular figures** (`fontVariant: ['tabular-nums']`) so credit/cash counters don't jitter in width as digits animate.

| Style | Size / Weight | Use |
|---|---|---|
| `display` | 28 / 700 | Onboarding, empty states |
| `title` | 20 / 600 | Screen headers, thread name |
| `body` | 16 / 400 | Message text |
| `bodyMedium` | 16 / 500 | Sender name, list titles |
| `caption` | 13 / 400 | Timestamps, word/credit-cost preview |
| `balance` | 24 / 700, tabular-nums | Wallet balance headline |

## 3. Spacing, radius, elevation

- 4px base grid: `space.xs=4, sm=8, md=12, lg=16, xl=24, xxl=32`.
- Radius: `radius.bubble=18, radius.card=16, radius.sheet=24 (top corners), radius.pill=999`.
- Elevation via soft, tinted shadows (violet-tinted in light mode, none/border in dark mode — pure black shadows on a near-black background are wasted), 3 levels only (`elevation.1/2/3`) to keep the shadow system simple.

## 4. Motion system

Built on **Reanimated 3** (UI-thread animations) + **Moti** for declarative wrappers, plus `react-native-gesture-handler` for gesture-driven interactions. Motion has a job in this app beyond delight: it must make the **money mechanics legible** — a credit debit, an escrow hold, an earning release should each *feel* distinct.

| Interaction | Motion spec |
|---|---|
| Message send | Bubble scales in from 0.8→1 with a spring (`damping: 15, stiffness: 180`), sends on a slight upward slide (mirrors WhatsApp's familiar feel) |
| **Credit debit on send** | The cost chip (e.g. "−2") flies from the input bar to the balance pill in the header and the balance pill number rolls down (odometer-style digit roll) — makes "this message just cost you money" viscerally clear without a modal |
| **Escrow pending** | Sent bubble shows a subtle pulsing amber dot/outline (`opacity 0.4↔1, 1.6s loop`) until B replies — communicates "held, not yet earned" at a glance |
| **Earning received (B's side)** | Balance pill flashes gold, a small "+N credits" toast rises and fades with a light haptic (`ImpactFeedbackStyle.Light`); on first earning ever, a one-time confetti burst (small, ≤ 400 particles, GPU-cheap) |
| Pull-to-refresh (chat list) | Custom spring-based rubber-banding, not the default OS spinner — replaced with the brand mark subtly rotating |
| Swipe-to-reply | 1:1 finger tracking via gesture-handler, snap-back spring if released before threshold (mirrors WhatsApp) |
| Screen transitions | Native-stack shared-element transition: tapping a chat-list row morphs the avatar+name into the thread header position (`react-navigation` shared element or `react-native-screens` native transitions) |
| Status ring | Animated gradient ring (violet→gold conic gradient) around avatars with unseen status, using `react-native-svg` + Reanimated-driven `strokeDashoffset`, not a GIF/Lottie |
| Low-balance warning | Input bar border animates to `color.semantic.danger` with a short shake (3× 4px horizontal, 250ms) when a message would exceed available balance, before the send even attempts server-side |
| Withdrawal countdown | The 24h auto-withdraw timer on the earnings screen is a thin circular progress ring that visibly drains — reinforces the "use it or it auto-withdraws" mechanic without needing copy to explain it |
| Skeletons | Shimmer skeletons (Reanimated `interpolate` on a translateX gradient) for chat list / thread load, not spinners |

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
