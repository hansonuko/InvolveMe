import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
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

/** The user's stored preference — `'system'` (default) tracks the OS
 * setting; `'light'`/`'dark'` pins it regardless of OS. Distinct from
 * `ThemeMode` (`'light' | 'dark'`, the actual palette key), since
 * `'system'` isn't a palette — it's resolved to one at render time. */
export type ThemePreference = 'system' | ThemeMode;

const THEME_PREFERENCE_STORAGE_KEY = 'involveme.themePreference';

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

const themeValue = (
  mode: ThemeMode,
  preference: ThemePreference,
  setPreference: (p: ThemePreference) => void,
  windowWidth: number,
) => ({
  mode,
  preference,
  setPreference,
  colors: palette[mode],
  spacing,
  radius,
  typography,
  layout: responsiveLayout(windowWidth),
});

export type Theme = ReturnType<typeof themeValue>;

const noopSetPreference = () => {
  throw new Error('setPreference called outside ThemeProvider');
};

const ThemeContext = createContext<Theme>(
  themeValue('light', 'system', noopSetPreference, RESPONSIVE_BASE_WIDTH),
);

/**
 * Defaults to the device color scheme (`preference: 'system'`). Settings >
 * Appearance can pin `'light'`/`'dark'` instead via `setPreference`,
 * persisted to AsyncStorage (same storage this app already uses for the
 * Supabase session — see lib/supabase.ts) so the choice survives an app
 * restart before the persisted value has even loaded.
 */
export function ThemeProvider({ children }: PropsWithChildren) {
  const scheme = useColorScheme();
  const { width } = useWindowDimensions();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(THEME_PREFERENCE_STORAGE_KEY).then((stored) => {
      if (!cancelled && (stored === 'light' || stored === 'dark' || stored === 'system')) {
        setPreferenceState(stored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    void AsyncStorage.setItem(THEME_PREFERENCE_STORAGE_KEY, next);
  }, []);

  const mode: ThemeMode =
    preference === 'system' ? (scheme === 'dark' ? 'dark' : 'light') : preference;

  const value = useMemo(
    () => themeValue(mode, preference, setPreference, width),
    [mode, preference, setPreference, width],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
