import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';

import {
  layout,
  palette,
  radius,
  RESPONSIVE_BASE_WIDTH,
  RESPONSIVE_SCALE_MAX,
  RESPONSIVE_SCALE_MIN,
  spacing,
  typography,
  type ThemeMode,
} from './tokens';

/** Scales `layout`'s reference sizes (measured at `RESPONSIVE_BASE_WIDTH`)
 * to the device's actual screen width, clamped to a modest range — added
 * 2026-09-14 on an explicit "header/bottom bars should be dynamic and
 * responsive, adjusting automatically on a smaller or bigger screen with
 * the same look and feel" ask. `useWindowDimensions` (not the static
 * `Dimensions.get`) so this re-renders correctly if the window size ever
 * changes at runtime (e.g. a foldable, or split-screen on tablets/Android)
 * even though this app is portrait-only today. */
function responsiveLayout(windowWidth: number) {
  const scale = Math.min(
    Math.max(windowWidth / RESPONSIVE_BASE_WIDTH, RESPONSIVE_SCALE_MIN),
    RESPONSIVE_SCALE_MAX,
  );
  return {
    barHeight: Math.round(layout.barHeight * scale),
    tabIconSize: Math.round(layout.tabIconSize * scale),
    headerIconSize: Math.round(layout.headerIconSize * scale),
  };
}

const themeValue = (mode: ThemeMode, windowWidth: number) => ({
  mode,
  colors: palette[mode],
  spacing,
  radius,
  typography,
  layout: responsiveLayout(windowWidth),
});

export type Theme = ReturnType<typeof themeValue>;

const ThemeContext = createContext<Theme>(themeValue('light', RESPONSIVE_BASE_WIDTH));

/**
 * Defaults to the device color scheme. A manual override (Settings > Appearance)
 * can be layered on top later by passing an explicit `mode` prop — not needed
 * for Phase 0.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  const scheme = useColorScheme();
  const { width } = useWindowDimensions();
  const value = useMemo(
    () => themeValue(scheme === 'dark' ? 'dark' : 'light', width),
    [scheme, width],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
