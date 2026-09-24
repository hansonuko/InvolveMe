'use client';

import { useActionState } from 'react';
import { createAdminAction, type ActionState } from '@/app/actions/auth';

type Role = { id: string; name: string; description: string };

export function CreateAdminForm({ roles }: { roles: Role[] }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    createAdminAction,
    null,
  );

  return (
    <form action={formAction} className="mt-6 max-w-lg">
      <label className="block text-xs font-medium text-[var(--foreground)]/70">Email</label>
      <input
        name="email"
        type="email"
        required
        className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)]"
      />

      <label className="mt-4 block text-xs font-medium text-[var(--foreground)]/70">
        Display name
      </label>
      <input
        name="display_name"
        required
        className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)]"
      />

      <label className="mt-4 block text-xs font-medium text-[var(--foreground)]/70">
        Temporary password (12+ characters — they’ll set their own on first login in a later phase)
      </label>
      <input
        name="temp_password"
        type="text"
        required
        minLength={12}
        className="mt-1 w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)]"
      />

      <fieldset className="mt-4">
        <legend className="text-xs font-medium text-[var(--foreground)]/70">Roles</legend>
        <div className="mt-2 space-y-2">
          {roles.map((role) => (
            <label
              key={role.id}
              className="flex items-start gap-2 text-sm text-[var(--foreground)]"
            >
              <input type="checkbox" name="role_ids" value={role.id} className="mt-1" />
              <span>
                <span className="font-medium">{role.name}</span>
                <span className="block text-xs text-[var(--foreground)]/60">
                  {role.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {state && 'error' in state && (
        <p className="mt-4 text-sm text-[var(--danger)]" role="alert">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-6 rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)] disabled:opacity-60"
      >
        {pending ? 'Creating…' : 'Create admin'}
      </button>
    </form>
  );
}
