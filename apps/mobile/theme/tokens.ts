/**
 * Design tokens — implements docs/04-DESIGN-SYSTEM.md.
 *
 * These are the ONLY place colors/spacing/type/radius values are defined.
 * Components consume tokens via `useTheme()` (see ./ThemeProvider) — never
 * hardcode a hex value or raw number in a component. If a value isn't here,
 * it belongs here before it belongs in a component.
 */

// 2026-09-14 palette refinement, requested against exactly two anchor
// colors — canvas #FDFFF7 and brand wine #5F1B31 (the 2026-09-13 rebrand's
// brand color, reconfirmed unchanged). Every other light-mode token below
// is now *derived* from those two by mixing wine into near-white (surfaces/
// borders) or near-black (ink text) at defined ratios, rather than picked
// ad hoc — see docs/04-DESIGN-SYSTEM.md §1 for the exact ratios and the
// contrast audit that came out of it. Two real accessibility bugs this
// caught, not just a re-tint: `success`/`danger` (both actively used as
// text throughout the app) failed WCAG AA (2.6:1 / 3.7:1) against the new,
// brighter canvas — darkened to pass 4.5:1 while staying recognizably
// green/red. `accentCredit` also fails at 2.0:1 but is intentionally left
// vivid (see its own comment below) since nothing renders it as text today.
export const palette = {
  light: {
    bgCanvas: '#FDFFF7',
    bgSurface: '#FFFFFF',
    // 10% wine mixed into near-white — replaces the old #FFE6D8 peach,
    // which related to neither anchor color (exactly the "odd/unmatched"
    // case this refinement was asked to fix). Used for input fields, list-
    // row press states, incoming message bubbles.
    bgSurfaceAlt: '#EDE8E3',
    brandPrimary: '#5F1B31',
    brandPrimaryPressed: '#471425',
    // Intentionally not derived from wine/near-white, and intentionally
    // not darkened for AA text contrast (2.0:1 against bgSurface) — this
    // is the one accent this app deliberately keeps distinct from the
    // brand hue (docs/04 §1's "gold = my value" association) and nothing
    // renders it as text today (grep-verified). If a future screen ever
    // sets Text color="credit", it needs a separate darker text-only
    // variant at that point — don't quietly reuse this value for text.
    accentCredit: '#F5A623',
    // Darkened from the original #12B76A/#F04438/#F79009 to actually pass
    // 4.5:1 against the new brighter bgCanvas — both success and danger
    // are live today as Text colors (error/confirmation messages) and
    // were failing AA before this fix, not a hypothetical.
    success: '#0D874E',
    danger: '#D63D32',
    warning: '#AA6306',
    // 15% wine mixed into black — a warm "ink" rather than flat #000000,
    // imperceptibly different at a glance (20:1 contrast either way) but
    // ties primary text into the two-anchor system instead of being an
    // unrelated pure neutral.
    textPrimary: '#0E0407',
    textSecondary: '#5F1B31',
    // 30% wine mixed into neutral gray — replaces the old flat #8A8A8A
    // (same "unrelated neutral" issue as bgSurfaceAlt had), still muted
    // enough for secondary reading at 5.05:1 against bgCanvas.
    textTertiary: '#7D696F',
    // "On brand" color — bottom-nav labels/icons, badge text, and the
    // primary button label all sit on a wine-colored surface regardless of
    // app theme, so this is the near-white anchor reused directly rather
    // than a third, unrelated light tone — deliberately identical in both
    // themes (see dark palette below).
    textInverse: '#FDFFF7',
    // 6% wine mixed into near-white — one step lighter than bgSurfaceAlt,
    // same derivation family.
    borderSubtle: '#F4F1EB',
    badgeBg: '#5F1B31',
    badgeText: '#FDFFF7',
  },
  dark: {
    // Dark mode wasn't part of this refinement's ask (only the two named
    // anchor colors were, both light-mode) and keeps the 2026-09-13
    // rebrand's own conservative extrapolation — flagged there and in
    // docs/04 §1 as due for a real pass if a dark-mode design is ever
    // actually specified. textInverse/badgeText below are the one
    // exception: kept identical to the light palette's new value, since
    // both are documented as theme-fixed "on brand" colors, not something
    // that should drift out of sync just because light mode changed.
    bgCanvas: '#1A1013',
    bgSurface: '#241820',
    bgSurfaceAlt: '#3A2430',
    brandPrimary: '#C97D91',
    brandPrimaryPressed: '#B5677B',
    accentCredit: '#FFC24D',
    success: '#32D583',
    danger: '#F97066',
    warning: '#FDB022',
    textPrimary: '#F5EDE9',
    textSecondary: '#E7A9BA',
    textTertiary: '#A8A29E',
    textInverse: '#FDFFF7',
    borderSubtle: '#3A2A30',
    badgeBg: '#5F1B31',
    badgeText: '#FDFFF7',
  },
} as const;

export type ThemeMode = keyof typeof palette;
export type ColorToken = keyof typeof palette.light;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  bubble: 18,
  card: 16,
  sheet: 24,
  pill: 999,
} as const;

// System font stack only — no bundled custom fonts, see docs/04-DESIGN-SYSTEM.md §2
// (RN resolves the platform default automatically when fontFamily is left undefined).
export const typography = {
  // Top-level brand wordmark ("InvolveMe" in the Chats header) — deliberately
  // heavier/larger than `display`, per docs/04-DESIGN-SYSTEM.md §2: the app
  // name should read as a wordmark, not just another screen title.
  brand: { fontSize: 30, fontWeight: '800' as const, letterSpacing: 0.2 },
  display: { fontSize: 28, fontWeight: '700' as const },
  title: { fontSize: 20, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  bodyMedium: { fontSize: 16, fontWeight: '500' as const },
  caption: { fontSize: 13, fontWeight: '400' as const },
  // Bottom tab bar labels — bolder/larger than React Navigation's default
  // (~11/500) so the tab bar reads as more prominent, per
  // docs/04-DESIGN-SYSTEM.md §2.
  tabBarLabel: { fontSize: 12, fontWeight: '700' as const },
  balance: {
    fontSize: 24,
    fontWeight: '700' as const,
    // Mutable array cast (not `as const`) — RN's TextStyle.fontVariant wants
    // FontVariant[], not a readonly tuple.
    fontVariant: ['tabular-nums'] as 'tabular-nums'[],
  },
} as const;
