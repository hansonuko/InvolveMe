/**
 * Design tokens — implements docs/04-DESIGN-SYSTEM.md.
 *
 * These are the ONLY place colors/spacing/type/radius values are defined.
 * Components consume tokens via `useTheme()` (see ./ThemeProvider) — never
 * hardcode a hex value or raw number in a component. If a value isn't here,
 * it belongs here before it belongs in a component.
 */

export const palette = {
  light: {
    bgCanvas: '#FAFAFC',
    bgSurface: '#FFFFFF',
    bgSurfaceAlt: '#F1F0F7',
    brandPrimary: '#5B3DF5',
    brandPrimaryPressed: '#4527D6',
    accentCredit: '#F5A623',
    success: '#12B76A',
    danger: '#F04438',
    warning: '#F79009',
    textPrimary: '#14131F',
    textSecondary: '#6B6879',
    borderSubtle: '#E7E5F0',
  },
  dark: {
    bgCanvas: '#0B0B10',
    bgSurface: '#16161D',
    bgSurfaceAlt: '#1E1E28',
    brandPrimary: '#7C5CFF',
    brandPrimaryPressed: '#6A4AE8',
    accentCredit: '#FFC24D',
    success: '#32D583',
    danger: '#F97066',
    warning: '#FDB022',
    textPrimary: '#F2F1F8',
    textSecondary: '#A7A4B8',
    borderSubtle: '#2A2A35',
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
  display: { fontSize: 28, fontWeight: '700' as const },
  title: { fontSize: 20, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  bodyMedium: { fontSize: 16, fontWeight: '500' as const },
  caption: { fontSize: 13, fontWeight: '400' as const },
  balance: {
    fontSize: 24,
    fontWeight: '700' as const,
    // Mutable array cast (not `as const`) — RN's TextStyle.fontVariant wants
    // FontVariant[], not a readonly tuple.
    fontVariant: ['tabular-nums'] as 'tabular-nums'[],
  },
} as const;
