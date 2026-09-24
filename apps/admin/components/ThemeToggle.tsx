'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';

const OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

const noopSubscribe = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // next-themes only knows the real theme after the client mounts (the
  // server has no way to know the admin's OS preference or prior
  // localStorage choice) — rendering the real selection before that would
  // either mismatch hydration or flash the wrong option briefly.
  // useSyncExternalStore's server/client snapshot split gives an exact
  // "has hydration finished" signal without setState-in-an-effect (which
  // this project's lint config flags as cascading-render-prone).
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  return (
    <div
      className="flex items-center gap-0.5 rounded border border-[var(--border)] p-0.5"
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={mounted && theme === opt.value}
          onClick={() => setTheme(opt.value)}
          className={`rounded px-2 py-1 text-xs transition-colors ${
            mounted && theme === opt.value
              ? 'bg-[var(--accent)] text-[var(--on-accent)]'
              : 'text-[var(--foreground)]/60 hover:text-[var(--foreground)]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
