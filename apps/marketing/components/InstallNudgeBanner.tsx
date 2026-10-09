'use client';

import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';

const DISMISSED_KEY = 'involveme-install-nudge-dismissed';
const WEB_APP_URL = process.env.NEXT_PUBLIC_WEB_APP_URL ?? 'https://involveme-web.pages.dev';

const noopSubscribe = () => () => {};

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

/**
 * Sitewide, dismissible nudge toward the installable PWA — docs/22-FULL-PWA-
 * SCOPING.md §7 Phase C. This site and the PWA itself (apps/mobile's web
 * export) are two separate Cloudflare Pages origins, so there's no real
 * cross-origin way to trigger the actual install prompt from here — the
 * genuine `beforeinstallprompt`/iOS instructions already live on the PWA's
 * own origin (`components/InstallPwaPrompt.tsx` in apps/mobile). This is a
 * promotional link over to that experience, not a second copy of it.
 *
 * Suppressed on `/download` specifically — that page already has the full
 * real install walkthrough inline, so a floating banner repeating "go
 * install" on top of it would just be noise, not a second nudge.
 *
 * `useSyncExternalStore`'s server/client snapshot split (same pattern
 * ThemeToggle.tsx already uses) is what lets this read `localStorage`
 * safely on a statically-exported page without a hydration mismatch or a
 * `react-hooks/set-state-in-effect` violation — the dismissed flag is
 * computed as part of the snapshot itself, never set via an effect body.
 */
export function InstallNudgeBanner() {
  const pathname = usePathname();
  const [closedThisVisit, setClosedThisVisit] = useState(false);

  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const dismissedBefore = useSyncExternalStore(
    noopSubscribe,
    () => window.localStorage.getItem(DISMISSED_KEY) === '1',
    () => false,
  );

  if (!mounted || dismissedBefore || closedThisVisit) return null;
  if (pathname === '/download') return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, '1');
    setClosedThisVisit(true);
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)]">
      <div className="mx-auto flex max-w-6xl items-center gap-4">
        <div className="flex-1">
          <p className="text-caption font-semibold text-foreground">Install InvolveMe</p>
          <p className="text-caption text-muted">
            {isIos()
              ? 'Open the app, then tap Share → Add to Home Screen.'
              : 'Add it to your home screen for the full app experience.'}
          </p>
        </div>
        <a
          href={WEB_APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="whitespace-nowrap rounded-pill bg-accent px-5 py-2.5 text-caption font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
        >
          Open app
        </a>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-pill text-muted transition-colors hover:text-foreground"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
