'use client';

import { motion } from 'framer-motion';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/Modal';
import { LAUNCH_DATE, LAUNCH_DATE_LABEL } from '@/lib/prelaunch';

function daysRemaining() {
  const diff = LAUNCH_DATE.getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

// Fires on every visit to the homepage (no "mounted" dismissal, no
// localStorage suppression — deliberately unlike InstallNudgeBanner's
// once-ever dismiss, per the explicit "every visit" ask) announcing the
// soft-launch countdown. Only mounted from app/page.tsx, not the root
// layout, so it never shows on any other page.
//
// Short entrance delay (not instant on paint) so it reads as an
// announcement arriving, not a layout element — same reasoning
// WebDevicePairingScreen's own hero/card stagger uses on the mobile side.
export function PrelaunchPopup() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number | null>(null);

  useEffect(() => {
    // Deferred one microtask out, not called directly in the effect body —
    // same react-hooks/set-state-in-effect pattern WebDevicePairingScreen's
    // own poll effect uses for its initial countdown value.
    queueMicrotask(() => setDays(daysRemaining()));
    const timer = setTimeout(() => setOpen(true), 700);
    return () => clearTimeout(timer);
  }, []);

  const goToWhatToExpect = () => {
    setOpen(false);
    router.push('/what-to-expect');
  };

  return (
    <Modal open={open} onClose={() => setOpen(false)} labelledBy="prelaunch-popup-title">
      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.15, type: 'spring', stiffness: 300, damping: 18 }}
        className="mx-auto flex h-16 w-16 items-center justify-center rounded-pill bg-accent/15 text-3xl"
        aria-hidden="true"
      >
        🚀
      </motion.div>

      <p className="mt-5 text-caption font-semibold uppercase tracking-widest text-foreground-accent">
        Soft launch countdown
      </p>
      <h2 id="prelaunch-popup-title" className="mt-2 text-title font-extrabold text-foreground">
        InvolveMe opens {LAUNCH_DATE_LABEL}
      </h2>

      <motion.p
        key={days ?? 'loading'}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-3 text-display font-extrabold text-foreground-accent"
      >
        {days === null
          ? ' '
          : days === 0
            ? "It's launch day!"
            : `${days} day${days === 1 ? '' : 's'} to go`}
      </motion.p>

      <p className="mx-auto mt-4 max-w-sm text-body text-muted">
        Get paid every time you reply to a message — no ads, no subscriptions, just real
        conversations that pay you back. See what&apos;s coming, and how to get in on day one.
      </p>

      <motion.button
        type="button"
        onClick={goToWhatToExpect}
        whileHover={{ scale: 1.03 }}
        whileTap={{ scale: 0.97 }}
        className="mt-7 w-full rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
      >
        See what to expect →
      </motion.button>

      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-4 text-caption text-muted hover:underline"
      >
        Maybe later
      </button>
    </Modal>
  );
}
