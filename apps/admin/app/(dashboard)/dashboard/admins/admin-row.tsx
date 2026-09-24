'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import {
  setAdminRolesAction,
  resetAdminMfaAction,
  proposeAdminAccountStatusChangeAction,
  type AdminActionState,
} from '@/app/actions/admins';

type Role = { id: string; name: string; description: string };

type AdminUserRow = {
  id: string;
  email: string;
  display_name: string;
  disabled_at: string | null;
  totp_enrolled_at: string | null;
  last_login_at: string | null;
  created_at: string;
};

type PendingStatusChange = {
  id: string;
  status: string;
  payload: { target_admin_id?: string; disable?: boolean };
};

export function AdminRow({
  admin,
  isSelf,
  roles,
  assignedRoleIds,
  pendingStatusChange,
}: {
  admin: AdminUserRow;
  isSelf: boolean;
  roles: Role[];
  assignedRoleIds: string[];
  pendingStatusChange: PendingStatusChange | null;
}) {
  const [editingRoles, setEditingRoles] = useState(false);
  const [rolesState, rolesFormAction, rolesPending] = useActionState<AdminActionState, FormData>(
    setAdminRolesAction,
    null,
  );
  const [mfaState, mfaFormAction, mfaPending] = useActionState<AdminActionState, FormData>(
    resetAdminMfaAction,
    null,
  );
  const [statusState, statusFormAction, statusPending] = useActionState<AdminActionState, FormData>(
    proposeAdminAccountStatusChangeAction,
    null,
  );

  const assignedRoleNames = roles.filter((r) => assignedRoleIds.includes(r.id)).map((r) => r.name);

  return (
    <div className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--foreground)]">
            {admin.display_name}
            {isSelf && <span className="ml-2 text-xs text-[var(--foreground)]/40">(you)</span>}
          </p>
          <p className="text-xs text-[var(--foreground)]/60">{admin.email}</p>
          <p className="mt-1 text-xs text-[var(--foreground)]/60">
            {assignedRoleNames.length > 0 ? assignedRoleNames.join(', ') : 'No roles assigned'}
          </p>
          <p className="mt-1 text-xs text-[var(--foreground)]/40">
            {admin.disabled_at ? 'Disabled' : 'Active'} · MFA{' '}
            {admin.totp_enrolled_at ? 'enrolled' : 'not enrolled'} · Last login{' '}
            {admin.last_login_at ? new Date(admin.last_login_at).toLocaleString() : 'never'}
          </p>
        </div>

        {!isSelf && (
          <div className="flex flex-col items-end gap-2">
            {pendingStatusChange ? (
              <div className="rounded border border-[var(--border)] px-3 py-1.5 text-right text-xs text-[var(--foreground)]/70">
                <p>
                  {pendingStatusChange.status === 'approved'
                    ? 'Approved — ready to apply'
                    : 'Pending approval'}
                  {' → '}
                  {pendingStatusChange.payload.disable ? 'Disable' : 'Reactivate'}
                </p>
                <Link
                  href="/dashboard/pending-actions"
                  className="text-[var(--accent)] hover:underline"
                >
                  View in queue →
                </Link>
              </div>
            ) : (
              <form action={statusFormAction}>
                <input type="hidden" name="target_admin_id" value={admin.id} />
                <input type="hidden" name="disable" value={admin.disabled_at ? 'false' : 'true'} />
                <button
                  type="submit"
                  disabled={statusPending}
                  className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)]/80 hover:text-[var(--foreground)] disabled:opacity-60"
                >
                  {admin.disabled_at ? 'Propose reactivation' : 'Propose disable'}
                </button>
              </form>
            )}

            <form action={mfaFormAction}>
              <input type="hidden" name="target_admin_id" value={admin.id} />
              <button
                type="submit"
                disabled={mfaPending}
                className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--foreground)]/80 hover:text-[var(--foreground)] disabled:opacity-60"
              >
                Reset MFA
              </button>
            </form>

            <button
              type="button"
              onClick={() => setEditingRoles((v) => !v)}
              className="text-xs text-[var(--foreground)]/70 hover:text-[var(--foreground)] hover:underline"
            >
              {editingRoles ? 'Cancel' : 'Edit roles'}
            </button>
          </div>
        )}
      </div>

      {statusState && 'error' in statusState && (
        <p className="mt-2 text-xs text-red-400" role="alert">
          {statusState.error}
        </p>
      )}
      {mfaState && 'error' in mfaState && (
        <p className="mt-2 text-xs text-red-400" role="alert">
          {mfaState.error}
        </p>
      )}

      {editingRoles && !isSelf && (
        <form
          action={rolesFormAction}
          className="mt-4 max-w-md rounded border border-[var(--border)] p-3"
        >
          <input type="hidden" name="target_admin_id" value={admin.id} />
          <div className="space-y-2">
            {roles.map((role) => (
              <label
                key={role.id}
                className="flex items-start gap-2 text-sm text-[var(--foreground)]"
              >
                <input
                  type="checkbox"
                  name="role_id"
                  value={role.id}
                  defaultChecked={assignedRoleIds.includes(role.id)}
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{role.name}</span>
                  <span className="block text-xs text-[var(--foreground)]/60">
                    {role.description}
                  </span>
                </span>
              </label>
            ))}
          </div>

          {rolesState && 'error' in rolesState && (
            <p className="mt-2 text-xs text-red-400" role="alert">
              {rolesState.error}
            </p>
          )}

          <button
            type="submit"
            disabled={rolesPending}
            className="mt-3 rounded bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
          >
            Save roles
          </button>
        </form>
      )}
    </div>
  );
}
