'use client';

import { useActionState } from 'react';
import { verifyMfaAction, type ActionState } from '@/app/actions/auth';

export default function MfaVerifyPage() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(verifyMfaAction, null);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] px-4">
      <form
        action={formAction}
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8"
      >
        <h1 className="text-lg font-semibold text-[var(--foreground)]">Enter your code</h1>
        <p className="mt-1 text-sm text-[var(--foreground)]/60">
          Your authenticator app’s 6-digit code, or a recovery code if you’ve lost access to it.
        </p>

        <label className="mt-6 block text-xs font-medium text-[var(--foreground)]/70">Code</label>
        <input
          name="code"
          required
          autoFocus
          className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm tracking-widest text-[var(--foreground)]"
        />

        {state && 'error' in state && (
          <p className="mt-4 text-sm text-[var(--danger)]" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="mt-6 w-full rounded bg-[var(--accent)] py-2 text-sm font-medium text-[var(--on-accent)] disabled:opacity-60"
        >
          {pending ? 'Verifying…' : 'Verify'}
        </button>
      </form>
    </main>
  );
}
