'use client';

import { useSearchParams } from 'next/navigation';

/**
 * `?verified=1` only ever matters post-hydration (it's a cosmetic
 * confirmation banner after the OTP signup redirect, not content a crawler
 * or first paint needs) — reading it via `useSearchParams()` instead of
 * the page's own `searchParams` prop is what makes this page static-
 * exportable at all (Cloudflare Pages deploy, docs/15 §7): a server
 * component awaiting `searchParams` forces dynamic rendering, which
 * `output: 'export'` can't produce. Caller wraps this in `<Suspense>`,
 * which `useSearchParams()` requires during static export.
 */
export function VerifiedBanner() {
  const searchParams = useSearchParams();
  if (searchParams.get('verified') !== '1') return null;

  return (
    <p className="mx-auto mb-6 inline-block rounded-pill bg-surface-alt px-5 py-2 text-caption font-semibold text-success">
      ✓ Your number is confirmed
    </p>
  );
}
