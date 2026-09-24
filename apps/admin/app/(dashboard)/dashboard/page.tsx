import Link from 'next/link';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { formatWalletAmount, WALLET_KIND_LABELS } from '@/lib/money';

const REVENUE_KINDS = ['platform_revenue_topup_fees', 'platform_revenue_earnings_cut'];

type PlatformWallet = { kind: string; currency: string; balance: number };

export default async function DashboardHomePage() {
  const admin = await getCurrentAdmin();
  if (!admin) return null;

  const [
    canViewUsers,
    canViewTreasury,
    canViewReportsQueue,
    canApprovePendingActions,
    canManageAdmins,
  ] = await Promise.all([
    checkPermission(admin.id, 'view_users'),
    checkPermission(admin.id, 'view_treasury'),
    checkPermission(admin.id, 'view_reports_queue'),
    checkPermission(admin.id, 'approve_pending_action'),
    checkPermission(admin.id, 'manage_admin_roles'),
  ]);

  const [
    { count: userCount },
    { data: revenueWalletRows },
    { count: unresolvedFraudCount },
    { count: unresolvedReportCount },
    { count: pendingActionCount },
    { count: adminCount },
  ] = await Promise.all([
    canViewUsers
      ? db().from('users').select('id', { count: 'exact', head: true })
      : Promise.resolve({ count: null }),
    canViewTreasury
      ? db()
          .from('wallets')
          .select('kind, currency, balance')
          .is('user_id', null)
          .in('kind', REVENUE_KINDS)
      : Promise.resolve({ data: null }),
    canViewReportsQueue
      ? db()
          .from('fraud_signals')
          .select('id', { count: 'exact', head: true })
          .is('resolved_at', null)
      : Promise.resolve({ count: null }),
    canViewReportsQueue
      ? db()
          .from('user_reports')
          .select('id', { count: 'exact', head: true })
          .is('resolved_at', null)
      : Promise.resolve({ count: null }),
    canApprovePendingActions
      ? db()
          .from('admin_pending_actions')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'pending')
      : Promise.resolve({ count: null }),
    canManageAdmins
      ? db().from('admin_users').select('id', { count: 'exact', head: true })
      : Promise.resolve({ count: null }),
  ]);
  const revenueWallets = (revenueWalletRows ?? []) as PlatformWallet[];

  const revenueByCurrency = new Map<string, PlatformWallet[]>();
  for (const w of revenueWallets) {
    const list = revenueByCurrency.get(w.currency) ?? [];
    list.push(w);
    revenueByCurrency.set(w.currency, list);
  }

  const hasAnyTile =
    canViewUsers ||
    canViewTreasury ||
    canViewReportsQueue ||
    canApprovePendingActions ||
    canManageAdmins;

  return (
    <main className="p-8">
      <h1 className="text-lg font-semibold text-[var(--foreground)]">Dashboard</h1>
      <p className="mt-1 text-sm text-[var(--foreground)]/60">Signed in as {admin.displayName}.</p>

      {!hasAnyTile && (
        <p className="mt-6 text-sm text-[var(--foreground)]/60">
          No dashboard sections are enabled for your role yet — contact a super admin if this looks
          wrong.
        </p>
      )}

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {canViewUsers && (
          <StatCard href="/dashboard/users" label="Users">
            <p className="text-2xl font-semibold text-[var(--foreground)]">
              {(userCount ?? 0).toLocaleString()}
            </p>
          </StatCard>
        )}

        {canViewTreasury && (
          <StatCard href="/dashboard/treasury" label="Treasury — revenue">
            {revenueByCurrency.size === 0 ? (
              <p className="text-sm text-[var(--foreground)]/60">No platform wallets yet.</p>
            ) : (
              <div className="space-y-1">
                {Array.from(revenueByCurrency.entries()).map(([currency, wallets]) => (
                  <div key={currency}>
                    <p className="text-xs font-medium text-[var(--foreground)]/60">{currency}</p>
                    {wallets.map((w) => (
                      <p key={w.kind} className="text-sm font-semibold text-[var(--foreground)]">
                        {formatWalletAmount(w.balance, w.kind, w.currency)}{' '}
                        <span className="text-xs font-normal text-[var(--foreground)]/40">
                          {WALLET_KIND_LABELS[w.kind] ?? w.kind}
                        </span>
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </StatCard>
        )}

        {canViewReportsQueue && (
          <StatCard href="/dashboard/fraud-signals" label="Unresolved fraud signals">
            <p className="text-2xl font-semibold text-[var(--foreground)]">
              {(unresolvedFraudCount ?? 0).toLocaleString()}
            </p>
          </StatCard>
        )}

        {canViewReportsQueue && (
          <StatCard href="/dashboard/user-reports" label="Unresolved user reports">
            <p className="text-2xl font-semibold text-[var(--foreground)]">
              {(unresolvedReportCount ?? 0).toLocaleString()}
            </p>
          </StatCard>
        )}

        {canApprovePendingActions && (
          <StatCard href="/dashboard/pending-actions" label="Pending actions awaiting decision">
            <p className="text-2xl font-semibold text-[var(--foreground)]">
              {(pendingActionCount ?? 0).toLocaleString()}
            </p>
          </StatCard>
        )}

        {canManageAdmins && (
          <StatCard href="/dashboard/admins" label="Admin accounts">
            <p className="text-2xl font-semibold text-[var(--foreground)]">
              {(adminCount ?? 0).toLocaleString()}
            </p>
          </StatCard>
        )}
      </div>
    </main>
  );
}

function StatCard({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="block rounded border border-[var(--border)] bg-[var(--surface)] p-4 hover:border-[var(--accent)]"
    >
      <p className="text-xs font-medium text-[var(--foreground)]/60">{label}</p>
      <div className="mt-2">{children}</div>
    </Link>
  );
}
