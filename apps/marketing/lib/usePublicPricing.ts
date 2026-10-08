'use client';

import { useEffect, useState } from 'react';
import { FALLBACK, getPublicPricing, type PublicPricing } from './pricing';

/**
 * Starts with `FALLBACK` (today's known-correct v1 defaults, see
 * lib/pricing.ts) so Pricing/How-it-works render real numbers on first
 * paint, then swaps to the live `get-public-pricing` figures once the
 * fetch resolves — usually within one render, but never blocking.
 */
export function usePublicPricing(): PublicPricing {
  const [pricing, setPricing] = useState<PublicPricing>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    getPublicPricing().then((live) => {
      if (!cancelled) setPricing(live);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return pricing;
}
