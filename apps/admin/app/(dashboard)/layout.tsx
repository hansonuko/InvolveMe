import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { Sidebar, type NavGroup } from '@/components/Sidebar';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const canViewUsers = await checkPermission(admin.id, 'view_users');
  const canViewTreasury = await checkPermission(admin.id, 'view_treasury');
  const canViewReportsQueue = await checkPermission(admin.id, 'view_reports_queue');
  const canEditPricing = await checkPermission(admin.id, 'edit_pricing_config');
  const canApprovePendingActions = await checkPermission(admin.id, 'approve_pending_action');
  const canManageAdmins = await checkPermission(admin.id, 'manage_admin_roles');

  // Sub-routes fold into their closest parent's own nav item rather than
  // staying flat top-level links — the actual URL hierarchy already
  // groups them this way (/pricing/services, /pricing/strategy,
  // /pricing/history are all real children of /pricing), this just makes
  // the sidebar reflect that instead of listing nine unrelated-looking
  // flat items.
  const groups: NavGroup[] = [{ href: '/dashboard', label: 'Dashboard', icon: 'dashboard' }];

  if (canViewUsers) {
    groups.push({
      href: '/dashboard/users',
      label: 'Users',
      icon: 'users',
      children: [{ href: '/dashboard/users/analytics', label: 'Location stats' }],
    });
  }
  if (canViewTreasury) {
    groups.push({ href: '/dashboard/treasury', label: 'Treasury', icon: 'treasury' });
  }
  if (canViewReportsQueue) {
    groups.push({
      href: '/dashboard/fraud-signals',
      label: 'Fraud signals',
      icon: 'fraudSignals',
    });
    groups.push({
      href: '/dashboard/user-reports',
      label: 'User reports',
      icon: 'userReports',
    });
  }
  if (canEditPricing) {
    groups.push({
      href: '/dashboard/pricing',
      label: 'Pricing',
      icon: 'pricing',
      children: [
        { href: '/dashboard/pricing/services', label: 'Service pricing' },
        { href: '/dashboard/pricing/strategy', label: 'Message strategy' },
        { href: '/dashboard/pricing/history', label: 'Change history' },
      ],
    });
  }
  if (canApprovePendingActions) {
    groups.push({
      href: '/dashboard/pending-actions',
      label: 'Pending actions',
      icon: 'pendingActions',
    });
  }
  if (canManageAdmins) {
    groups.push({
      href: '/dashboard/admins',
      label: 'Admins',
      icon: 'admins',
      children: [{ href: '/dashboard/admins/new', label: 'Create admin' }],
    });
  }

  return (
    <div className="flex min-h-screen flex-col bg-[var(--background)] md:flex-row">
      <Sidebar groups={groups} adminDisplayName={admin.displayName} />
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
