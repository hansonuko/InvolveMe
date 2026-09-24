import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { AdminRow } from './admin-row';

type AdminUserRow = {
  id: string;
  email: string;
  display_name: string;
  disabled_at: string | null;
  totp_enrolled_at: string | null;
  last_login_at: string | null;
  created_at: string;
};

type Role = { id: string; name: string; description: string };

type PendingStatusChange = {
  id: string;
  status: string;
  payload: { target_admin_id?: string; disable?: boolean };
};

export default async function AdminsListPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'manage_admin_roles');
  if (!allowed) redirect('/dashboard');

  const [
    { data: adminRows, error: adminError },
    { data: roles },
    { data: userRoleRows },
    { data: pendingRows },
  ] = await Promise.all([
    db()
      .from('admin_users')
      .select('id, email, display_name, disabled_at, totp_enrolled_at, last_login_at, created_at')
      .order('created_at', { ascending: false }),
    db().from('admin_roles').select('id, name, description').order('name'),
    db().from('admin_user_roles').select('admin_user_id, role_id'),
    // Bounded — pending/approved admin_account_status_change rows are
    // never numerous, same reasoning as every other "active proposal"
    // lookup this dashboard already does (pricing strategy, withdrawals).
    db()
      .from('admin_pending_actions')
      .select('id, status, payload')
      .eq('action_type', 'admin_account_status_change')
      .in('status', ['pending', 'approved']),
  ]);

  const rows = (adminRows ?? []) as AdminUserRow[];
  const roleList = (roles ?? []) as Role[];

  const roleIdsByAdmin = new Map<string, string[]>();
  for (const ur of userRoleRows ?? []) {
    const list = roleIdsByAdmin.get(ur.admin_user_id) ?? [];
    list.push(ur.role_id);
    roleIdsByAdmin.set(ur.admin_user_id, list);
  }

  const pendingChangeByAdmin = new Map<string, PendingStatusChange>();
  for (const p of (pendingRows ?? []) as PendingStatusChange[]) {
    if (p.payload?.target_admin_id) pendingChangeByAdmin.set(p.payload.target_admin_id, p);
  }

  return (
    <main className="p-8">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--foreground)]">Admins</h1>
        <Link
          href="/dashboard/admins/new"
          className="rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)]"
        >
          Create admin account
        </Link>
      </div>
      <p className="mt-1 max-w-2xl text-sm text-[var(--foreground)]/60">
        Disabling or reactivating an account requires a different admin&apos;s approval (docs/14
        §4.4) — everything else here applies immediately and is written to the audit log.
      </p>

      {adminError && (
        <p className="mt-4 text-sm text-[var(--danger)]">
          Could not load admins: {adminError.message}
        </p>
      )}

      <div className="mt-6 divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--surface)]">
        {rows.map((row) => (
          <AdminRow
            key={row.id}
            admin={row}
            isSelf={row.id === admin.id}
            roles={roleList}
            assignedRoleIds={roleIdsByAdmin.get(row.id) ?? []}
            pendingStatusChange={pendingChangeByAdmin.get(row.id) ?? null}
          />
        ))}
        {rows.length === 0 && !adminError && (
          <p className="p-4 text-sm text-[var(--foreground)]/60">No admins yet.</p>
        )}
      </div>
    </main>
  );
}
