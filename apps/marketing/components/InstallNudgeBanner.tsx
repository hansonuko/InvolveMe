'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useSyncExternalStore } from 'react';

const DISMISSED_KEY = 'involveme-install-nudge-dismissed';

const noopSubscribe = () => () => {};

/**
 * Sitewide, dismissible nudge toward the Download page.
 *
 * Reversed 2026-10-09 (session 44): this used to link straight to
 * involveme-web as an installable PWA any visitor could open and use —
 * that assumption is exactly what docs/12-LINKED-DEVICES-WEB-SCOPING.md's
 * architecture pivot invalidated (involveme-web is a QR-pairing companion
 * client now, reachable only from an already-logged-in phone; see
 * app/download/page.tsx's own header comment for the full finding). This
 * banner now points at `/download` instead, which has the real,
 * currently-accurate per-platform story (Android sideload, iOS not yet
 * available) — a promotional nudge toward that page, not a second copy
 * of its content.
 *
 * Suppressed on `/download` specifically — that page already has the
 * full real install walkthrough inline, so a floating banner repeating
 * "go install" on top of it would just be noise, not a second nudge.
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
          <p className="text-caption font-semibold text-foreground">Get InvolveMe</p>
          <p className="text-caption text-muted">
            See how to get it on your phone, Android today, iOS coming soon.
          </p>
        </div>
        <Link
          href="/download"
          className="whitespace-nowrap rounded-pill bg-accent px-5 py-2.5 text-caption font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
        >
          Download
        </Link>
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
