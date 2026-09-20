import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { logoutAction } from '@/app/actions/auth';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const canViewUsers = await checkPermission(admin.id, 'view_users');

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="text-sm font-medium text-[var(--foreground)]">InvolveMe Admin</span>
          <nav className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)]"
            >
              Dashboard
            </Link>
            {canViewUsers && (
              <Link
                href="/dashboard/users"
                className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)]"
              >
                Users
              </Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-[var(--foreground)]/60">{admin.email}</span>
          <form action={logoutAction}>
            <button
              type="submit"
              className="text-sm text-[var(--foreground)]/60 hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
