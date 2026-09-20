'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { confirmEnrollAction, type ActionState } from '@/app/actions/auth';

export function EnrollForm() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    confirmEnrollAction,
    null,
  );

  if (state && 'recoveryCodes' in state) {
    return (
      <div className="mt-6">
        <p className="text-sm font-medium text-[var(--foreground)]">
          Save these recovery codes now — each works once, and this is the only time they’re shown.
        </p>
        <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-sm text-[var(--foreground)]">
          {state.recoveryCodes.map((code) => (
            <li key={code} className="rounded border border-[var(--border)] bg-black/20 px-2 py-1">
              {code}
            </li>
          ))}
        </ul>
        <Link
          href="/dashboard"
          className="mt-6 block w-full rounded bg-[var(--accent)] py-2 text-center text-sm font-medium text-white"
        >
          I’ve saved them — continue
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} className="mt-6">
      <label className="block text-xs font-medium text-[var(--foreground)]/70">6-digit code</label>
      <input
        name="code"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm tracking-widest text-[var(--foreground)]"
      />
      {state && 'error' in state && (
        <p className="mt-3 text-sm text-red-400" role="alert">
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="mt-4 w-full rounded bg-[var(--accent)] py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? 'Verifying…' : 'Confirm'}
      </button>
    </form>
  );
}
