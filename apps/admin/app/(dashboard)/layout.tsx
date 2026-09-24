import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { logoutAction } from '@/app/actions/auth';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const canViewUsers = await checkPermission(admin.id, 'view_users');
  const canViewTreasury = await checkPermission(admin.id, 'view_treasury');
  const canViewReportsQueue = await checkPermission(admin.id, 'view_reports_queue');
  const canEditPricing = await checkPermission(admin.id, 'edit_pricing_config');
  const canApprovePendingActions = await checkPermission(admin.id, 'approve_pending_action');

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
            {canViewTreasury && (
              <Link
                href="/dashboard/treasury"
                className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)]"
              >
                Treasury
              </Link>
            )}
            {canViewReportsQueue && (
              <Link
                href="/dashboard/fraud-signals"
                className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)]"
              >
                Fraud signals
              </Link>
            )}
            {canViewReportsQueue && (
              <Link
                href="/dashboard/user-reports"
                className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)]"
              >
                User reports
              </Link>
            )}
            {canEditPricing && (
              <Link
                href="/dashboard/pricing"
                className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)]"
              >
                Pricing
              </Link>
            )}
            {canApprovePendingActions && (
              <Link
                href="/dashboard/pending-actions"
                className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)]"
              >
                Pending actions
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
