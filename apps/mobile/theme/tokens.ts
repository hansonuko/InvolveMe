/**
 * Design tokens — implements docs/04-DESIGN-SYSTEM.md.
 *
 * These are the ONLY place colors/spacing/type/radius values are defined.
 * Components consume tokens via `useTheme()` (see ./ThemeProvider) — never
 * hardcode a hex value or raw number in a component. If a value isn't here,
 * it belongs here before it belongs in a component.
 */

// 2026-09-13 rebrand ("Deep Wine" — see docs/04-DESIGN-SYSTEM.md §1):
// replaces the earlier violet+gold ("Involve Violet") direction. The brief
// this shipped from specified light-mode values only (a cream/wine
// messaging-app look); dark mode has no source spec to match, so its
// values below are a conservative extrapolation (same wine/milk brand
// hues, ported onto dark canvases) rather than a second designed look —
// flagged here and in docs/04 for a real dark-mode pass if one is wanted.
export const palette = {
  light: {
    bgCanvas: '#FBF9F1',
    bgSurface: '#FFFFFF',
    bgSurfaceAlt: '#FFE6D8',
    brandPrimary: '#5F1B31',
    brandPrimaryPressed: '#45131F',
    accentCredit: '#F5A623',
    success: '#12B76A',
    danger: '#F04438',
    warning: '#F79009',
    textPrimary: '#000000',
    textSecondary: '#5F1B31',
    textTertiary: '#8A8A8A',
    // "On brand" color — bottom-nav labels/icons and badge text all sit on
    // a wine-colored surface regardless of app theme, so this deliberately
    // doesn't change between light/dark (see dark palette below).
    textInverse: '#FFE6D8',
    borderSubtle: '#EAD9CD',
    badgeBg: '#5F1B31',
    badgeText: '#FFE6D8',
  },
  dark: {
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
    textInverse: '#FFE6D8',
    borderSubtle: '#3A2A30',
    badgeBg: '#5F1B31',
    badgeText: '#FFE6D8',
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
