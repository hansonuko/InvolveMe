'use client';

import { useActionState } from 'react';
import { loginPasswordAction, type ActionState } from '@/app/actions/auth';

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    loginPasswordAction,
    null,
  );

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--background)] px-4">
      <form
        action={formAction}
        className="w-full max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface)] p-8"
      >
        <h1 className="text-lg font-semibold text-[var(--foreground)]">InvolveMe Admin</h1>
        <p className="mt-1 text-sm text-[var(--foreground)]/60">Sign in to continue.</p>

        <label className="mt-6 block text-xs font-medium text-[var(--foreground)]/70">Email</label>
        <input
          name="email"
          type="email"
          required
          autoComplete="username"
          className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)]"
        />

        <label className="mt-4 block text-xs font-medium text-[var(--foreground)]/70">
          Password
        </label>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)]"
        />

        {state && 'error' in state && (
          <p className="mt-4 text-sm text-red-400" role="alert">
            {state.error}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          className="mt-6 w-full rounded bg-[var(--accent)] py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
