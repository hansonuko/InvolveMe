export { ThemeProvider, useTheme } from './ThemeProvider';
export type { ThemePreference } from './ThemeProvider';
export { layout, palette, radius, spacing, typography } from './tokens';
export type { ColorToken, ThemeMode } from './tokens';

// Note: `layout` above is the *reference* size table (measured at one
// screen width). Components should read bar/icon sizes from
// `useTheme().layout` instead — that's the screen-size-adjusted version
// ThemeProvider computes, not this module's static export.

/** Derives a translucent variant of a theme color at render time, rather
 * than hardcoding a separate rgba() literal alongside it (CLAUDE.md's
 * no-hardcoded-hex rule extends to this — the *source* must still be a
 * token, an opacity tweak on it isn't a new color). `hex` must be a plain
 * `#RRGGBB` token value, e.g. `colors.textInverse`. */
export function withAlpha(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
