import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import { useColorScheme } from 'react-native';

import { layout, palette, radius, spacing, typography, type ThemeMode } from './tokens';

const themeValue = (mode: ThemeMode) => ({
  mode,
  colors: palette[mode],
  spacing,
  radius,
  typography,
  layout,
});

export type Theme = ReturnType<typeof themeValue>;

const ThemeContext = createContext<Theme>(themeValue('light'));

/**
 * Defaults to the device color scheme. A manual override (Settings > Appearance)
 * can be layered on top later by passing an explicit `mode` prop — not needed
 * for Phase 0.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  const scheme = useColorScheme();
  const value = useMemo(() => themeValue(scheme === 'dark' ? 'dark' : 'light'), [scheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
