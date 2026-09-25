'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';

const noopSubscribe = () => () => {};

// Compact icon toggle (not a 3-way system/light/dark switch like
// apps/admin's) — a text-label toggle that size doesn't fit this site's
// nav bar next to the logo and mobile hamburger. Starts from the OS
// preference (next-themes defaultTheme="system") and becomes an explicit
// light/dark choice the first time it's clicked, the common pattern for a
// single always-visible nav toggle.
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // next-themes only knows the real (resolved) theme after the client
  // mounts — the server can't know the visitor's OS preference or prior
  // localStorage choice. useSyncExternalStore's server/client snapshot
  // split gives an exact "has hydration finished" signal without
  // setState-in-an-effect.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className="flex h-9 w-9 items-center justify-center rounded-card border border-border text-foreground transition-colors hover:border-accent"
    >
      {!mounted ? null : isDark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" fill="currentColor" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor" />
          <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
          </g>
        </svg>
      )}
    </button>
  );
}
