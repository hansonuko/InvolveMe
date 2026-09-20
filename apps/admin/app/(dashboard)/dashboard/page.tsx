import { getCurrentAdmin, checkPermission } from '@/lib/auth';

export default async function DashboardHomePage() {
  const admin = await getCurrentAdmin();
  const canManageAdmins = admin ? await checkPermission(admin.id, 'manage_admin_roles') : false;

  return (
    <main className="p-8">
      <h1 className="text-lg font-semibold text-[var(--foreground)]">Dashboard</h1>
      <p className="mt-2 text-sm text-[var(--foreground)]/60">
        Signed in as {admin?.displayName}. Real feature pages start in Phase B
        (docs/14-ADMIN-DASHBOARD-SCOPING.md).
      </p>

      {canManageAdmins && (
        <a
          href="/dashboard/admins/new"
          className="mt-6 inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
        >
          Create admin account
        </a>
      )}
    </main>
  );
}
