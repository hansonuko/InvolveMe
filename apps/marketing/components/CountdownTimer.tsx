'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { LAUNCH_DATE } from '@/lib/prelaunch';

function getTimeRemaining() {
  const diff = LAUNCH_DATE.getTime() - Date.now();
  if (diff <= 0) return null;
  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

function Unit({ value, label }: { value: number; label: string }) {
  const display = String(value).padStart(2, '0');
  return (
    <div className="flex flex-col items-center">
      <div className="relative h-16 w-16 overflow-hidden rounded-card bg-surface text-balance font-extrabold text-foreground md:h-20 md:w-20">
        <AnimatePresence mode="popLayout">
          <motion.span
            key={display}
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '-100%', opacity: 0 }}
            transition={{ duration: 0.35, ease: 'easeOut' }}
            className="absolute inset-0 flex items-center justify-center"
          >
            {display}
          </motion.span>
        </AnimatePresence>
      </div>
      <span className="mt-2 text-caption uppercase tracking-wide text-muted">{label}</span>
    </div>
  );
}

// "Fully animated" per the launch-countdown ask: each unit's digits flip in
// and out (Framer Motion, already a site dependency since Phase A) rather
// than just mutating a static number in place.
//
// Starts as null on both server and client (never call Date.now() during
// the initial render, same reasoning as ThemeToggle's mounted gate) — the
// server has no way to know the visitor's exact clock, and computing a
// real value at render time would mismatch the client's first paint and
// trigger a hydration error. The real value is only ever computed inside
// useEffect, after mount.
export function CountdownTimer() {
  const [remaining, setRemaining] = useState<ReturnType<typeof getTimeRemaining> | 'loading'>(
    'loading',
  );

  useEffect(() => {
    // Subscribing to a ticking clock, an external system, so setState
    // inside the interval callback is the correct pattern this project's
    // lint rule asks for; it only flags a synchronous setState call
    // directly in the effect body, which is why the first tick is left to
    // the interval itself rather than also calling it eagerly here.
    const interval = setInterval(() => setRemaining(getTimeRemaining()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (remaining === 'loading') {
    return <div className="h-16 md:h-20" aria-hidden="true" />;
  }

  if (!remaining) {
    return <p className="text-title font-extrabold text-foreground-accent">We&apos;re live!</p>;
  }

  return (
    <div className="flex items-start justify-center gap-4">
      <Unit value={remaining.days} label="Days" />
      <Unit value={remaining.hours} label="Hours" />
      <Unit value={remaining.minutes} label="Minutes" />
      <Unit value={remaining.seconds} label="Seconds" />
    </div>
  );
}
