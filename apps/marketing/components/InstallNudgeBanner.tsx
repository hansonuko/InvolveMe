'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';

const DISMISSED_KEY = 'involveme-install-nudge-dismissed';
const FULL_PWA_URL = 'https://app.involvemechat.com';

const noopSubscribe = () => () => {};

function isAndroidUa() {
  return /android/i.test(window.navigator.userAgent);
}

/**
 * Sitewide, dismissible nudge — what it promotes depends on the device.
 *
 * Reversed 2026-10-09 (session 44), then reinstated the same day (session
 * 45 continued): this originally linked straight to involveme-web as an
 * installable PWA — invalidated when that domain became docs/12's
 * QR-pairing companion client (reachable only from an already-logged-in
 * phone). The standalone installable app that assumption described didn't
 * go away, it moved to its own subdomain, `app.involvemechat.com` (see
 * `apps/mobile/lib/webAppMode.ts`) — so this banner is back to promoting
 * a real install, just at the corrected URL, and only for devices that
 * actually benefit from it: Android already has its own direct-APK path
 * (`/download`), so only non-Android visitors get sent straight to the
 * PWA install; Android still goes to `/download`.
 *
 * Suppressed on `/download` specifically — that page already has the
 * full real install walkthrough inline (including the same PWA link for
 * non-Android), so a floating banner repeating "go install" on top of it
 * would just be noise, not a second nudge.
 *
 * `useSyncExternalStore`'s server/client snapshot split (same pattern
 * ThemeToggle.tsx already uses) is what lets this read
 * `localStorage`/`navigator.userAgent` safely on a statically-exported
 * page without a hydration mismatch or a `react-hooks/set-state-in-effect`
 * violation — both are computed as part of the snapshot itself, never set
 * via an effect body.
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
  const isAndroid = useSyncExternalStore(noopSubscribe, isAndroidUa, () => false);

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
          <p className="text-caption font-semibold text-foreground">Get InvolveMe</p>
          <p className="text-caption text-muted">
            {isAndroid
              ? 'Not on the Play Store yet. Get the Android app directly.'
              : "Not on Android? Install the web app. We'll notify you when the native app is ready for your store."}
          </p>
        </div>
        {isAndroid ? (
          <Link
            href="/download"
            className="whitespace-nowrap rounded-pill bg-accent px-5 py-2.5 text-caption font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
          >
            Download
          </Link>
        ) : (
          <a
            href={FULL_PWA_URL}
            className="whitespace-nowrap rounded-pill bg-accent px-5 py-2.5 text-caption font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
          >
            Install
          </a>
        )}
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
