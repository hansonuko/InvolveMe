/**
 * Design tokens — implements docs/04-DESIGN-SYSTEM.md.
 *
 * These are the ONLY place colors/spacing/type/radius values are defined.
 * Components consume tokens via `useTheme()` (see ./ThemeProvider) — never
 * hardcode a hex value or raw number in a component. If a value isn't here,
 * it belongs here before it belongs in a component.
 */

// 2026-09-14 chrome correction (second pass, same day): the palette
// refinement above got the *neutrals* right but the chrome — bottom tab
// bar, header, search bar — was still using `brandPrimary` (wine) as a
// literal bar *background*, per the earlier "Deep Wine" mockup. Flagged
// back explicitly: bars should be the light-milk canvas (dark: a clean
// near-black) with wine/white *text and icons* on top, not the reverse —
// and the dark-mode accent (`#C97D91`/`#B5677B`, a lightened/pressed wine)
// reads as purple/mauve at that lightness, which it is not meant to.
//
// Fix, not a patch: `brandPrimary`/`brandPrimaryPressed` are now
// **theme-invariant** (the exact same wine in both modes) — they exist
// only for *filled* surfaces now (buttons, the unread badge), which are
// self-contained (their own fill + their own on-fill text contrast) and
// were never the thing being objected to; a small colored badge or a
// filled CTA button is a universally standard pattern, not "chrome."
// Lightening wine for dark-mode legibility is what produced the
// pink/mauve `#C97D91`/`#B5677B` in the first place — removing the
// lightened variant removes the purple, not just its name.
//
// The role that actually needs to invert per theme — "the accent color
// used for text/icons that sit directly on the canvas" (active tab,
// active sub-header indicator, header icon) — was already `textSecondary`
// in light mode (wine, correct), just not asked to differ in dark mode
// yet. It now does: plain white in dark mode, exactly as instructed
// ("white text"), not a tinted accent — this is a *content* color, not a
// bar fill, so nothing here reintroduces a "colored background" mistake.
export const palette = {
  light: {
    bgCanvas: '#FDFFF7',
    bgSurface: '#FFFFFF',
    // 10% wine mixed into near-white — replaces the old #FFE6D8 peach,
    // which related to neither anchor color. Used for input fields, list-
    // row press states, incoming message bubbles.
    bgSurfaceAlt: '#EDE8E3',
    // Filled-surface color only now (buttons, unread badge) — never a bar
    // background. See header comment for why this changed meaning.
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
    // The "accent used for text/icons on the canvas" role: active tab,
    // active sub-header indicator, header action icons, chat display
    // names. Wine in light mode; see dark below for why this is plain
    // white there instead of a lightened wine.
    textSecondary: '#5F1B31',
    // 30% wine mixed into neutral gray — replaces the old flat #8A8A8A,
    // still muted enough for secondary reading at 5.05:1 against bgCanvas.
    // Doubles as the inactive tab-icon/label tone.
    textTertiary: '#7D696F',
    // "On brand" color — for content that sits *on a filled wine surface*
    // specifically (badge text, primary-button label, own-message-bubble
    // text) — not bars, which no longer have a wine fill. Reuses the
    // canvas anchor directly. Deliberately identical in both themes.
    textInverse: '#FDFFF7',
    // 6% wine mixed into near-white — one step lighter than bgSurfaceAlt,
    // same derivation family. Also the bottom-tab-bar/header top border,
    // now that those bars are canvas-colored and need a hairline to read
    // as a distinct bar at all.
    borderSubtle: '#F4F1EB',
    badgeBg: '#5F1B31',
    badgeText: '#FDFFF7',
  },
  dark: {
    bgCanvas: '#1A1013',
    bgSurface: '#241820',
    bgSurfaceAlt: '#3A2430',
    // Theme-invariant — see header comment. A filled button/badge in dark
    // mode is still legible without lightening the fill itself; only the
    // fill's own label color would need to adapt, and it already does
    // (textInverse, unchanged by theme by design).
    brandPrimary: '#5F1B31',
    brandPrimaryPressed: '#471425',
    accentCredit: '#FFC24D',
    success: '#32D583',
    danger: '#F97066',
    warning: '#FDB022',
    textPrimary: '#F5EDE9',
    // Plain white in dark mode, not a lightened/tinted wine — this is
    // exactly the "reverse: dark background, white text" the correction
    // asked for. Same value as textPrimary is a deliberate simplification
    // (no separate "accent" hue in dark mode) rather than reintroducing
    // the pink/mauve problem by trying to keep one.
    textSecondary: '#F5EDE9',
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

// Added 2026-09-14, on an explicit "0.6 inch bars, bigger icons" ask.
// `barHeight` targets ~0.6in using the 160dp-per-inch baseline both
// platforms' "device-independent pixel" units are conventionally defined
// against (RN's own unit, same as CSS px on the mdpi/1x reference) — the
// OS scales this to each device's real pixel density, so it lands close
// to 0.6in on real hardware without being pixel-exact on every device
// (dp/pt were never meant to guarantee that, only to approximate it).
//
// These are the *reference* values, measured at `RESPONSIVE_BASE_WIDTH` —
// `ThemeProvider` is what actually hands out the screen-size-adjusted
// numbers via `useTheme().layout` (added same day, on an explicit
// "bars should adjust automatically on a smaller/bigger screen, same
// look and feel" ask). Nothing outside `theme/` should import this
// object directly for `barHeight`/`tabIconSize`/`headerIconSize` — go
// through `useTheme()` so the responsive scaling is never bypassed.
export const layout = {
  barHeight: 96,
  tabIconSize: 28,
  headerIconSize: 26,
} as const;

// 375 is the iPhone SE/8/X-class logical width — the most common RN
// design-reference baseline, and a reasonable "typical phone" midpoint.
// Scale is clamped fairly tightly (0.85–1.15): the ask is for the bars to
// *feel* consistent across real phone screens, not to shrink/balloon
// bar chrome dramatically on the small-phone/tablet extremes, where an
// uncapped linear scale would look worse, not better.
export const RESPONSIVE_BASE_WIDTH = 375;
export const RESPONSIVE_SCALE_MIN = 0.85;
export const RESPONSIVE_SCALE_MAX = 1.15;

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
  // docs/04-DESIGN-SYSTEM.md §2. Bumped 12→14 on 2026-09-14 alongside the
  // taller bar / bigger icons — proportionally similar to the "7pt→10pt"
  // example given for the ask, scaled to this token's own starting size.
  tabBarLabel: { fontSize: 14, fontWeight: '700' as const },
  balance: {
    fontSize: 24,
    fontWeight: '700' as const,
    // Mutable array cast (not `as const`) — RN's TextStyle.fontVariant wants
    // FontVariant[], not a readonly tuple.
    fontVariant: ['tabular-nums'] as 'tabular-nums'[],
  },
} as const;
