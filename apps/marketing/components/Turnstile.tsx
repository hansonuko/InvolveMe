'use client';

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'expired-callback'?: () => void;
        },
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
let scriptLoadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Turnstile script'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

// Bot-abuse guard in front of the OTP-send call (docs/15-MARKETING-SITE-
// PWA-SCOPING.md §4.4, non-negotiable — ships in the same phase as the
// signup form). A real Turnstile widget (sitekey 0x4AAAAAAFRCZapP4N0Af8Lf,
// scoped to involveme.net/www.involveme.net/involveme-marketing.pages.dev)
// has been live since 2026-10-08 — NEXT_PUBLIC_TURNSTILE_SITE_KEY is no
// longer Cloudflare's published always-pass test key. Still renders a
// clear "unavailable" state rather than crashing if the env var is ever
// unset again (a misconfigured future deploy, a different environment) —
// Send stays disabled in that case, which is the correct fail-closed
// posture, not a bypass.
export function Turnstile({ onVerify }: { onVerify: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);

  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: onVerify,
        });
      })
      .catch(() => {
        if (!cancelled) setFailedToLoad(true);
      });

    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey || failedToLoad) {
    return (
      <p className="text-caption text-muted">
        Verification is temporarily unavailable — signup is disabled until this is configured.
      </p>
    );
  }

  return <div ref={containerRef} />;
}
