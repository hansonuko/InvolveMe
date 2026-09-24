import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { PRICING_CATEGORY_ORDER, categoryForKey, pricingValueHint } from '@/lib/pricingCategories';
import { PricingConfigForm } from './actions-forms';

type PricingConfigRow = {
  key: string;
  currency: string;
  value: number;
  description: string | null;
  updated_at: string;
};

type PendingActionRow = {
  id: string;
  status: string;
  requested_by: string;
  payload: { key?: string; currency?: string; new_value?: number };
};

// Every _bps key requires dual approval (docs/14 §4.2/§4.4, Phase E piece
// 2) — matches fn_admin_update_pricing_config's own materiality rule
// exactly, so a key that isn't gated in the DB never shows the "propose"
// UI, and vice versa.
function isMaterialKey(key: string): boolean {
  return key.endsWith('_bps');
}

export default async function PricingPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  // No separate view_pricing_config permission exists (confirmed directly
  // against admin_permissions — only edit_pricing_config does), so this
  // page is gated the same as the write path it fronts: finance_admin and
  // super_admin only, matching docs/14 §4.1's role table.
  const allowed = await checkPermission(admin.id, 'edit_pricing_config');
  if (!allowed) redirect('/dashboard');

  const [{ data, error }, { data: pendingActions }] = await Promise.all([
    db()
      .from('pricing_config')
      .select('key, currency, value, description, updated_at')
      .order('key'),
    // Bounded (pending/approved pricing_config_update rows are never a
    // large table — every applied/rejected/expired one drops out of this
    // filter), so one unpaginated fetch is fine to build the per-row
    // "already proposed" lookup below.
    db()
      .from('admin_pending_actions')
      .select('id, status, requested_by, payload')
      .eq('action_type', 'pricing_config_update')
      .in('status', ['pending', 'approved']),
  ]);
  const rows = (data ?? []) as PricingConfigRow[];

  const activeProposalByKey = new Map<string, PendingActionRow>();
  for (const p of (pendingActions ?? []) as PendingActionRow[]) {
    if (p.payload?.key && p.payload?.currency) {
      activeProposalByKey.set(`${p.payload.key}:${p.payload.currency}`, p);
    }
  }

  const grouped = new Map<string, PricingConfigRow[]>();
  for (const row of rows) {
    const category = categoryForKey(row.key);
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category)!.push(row);
  }
  const orderedLabels = PRICING_CATEGORY_ORDER.filter((label) => grouped.has(label));

  return (
    <main className="p-8">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-[var(--foreground)]">Pricing config</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--foreground)]/60">
            A change here takes effect immediately for transactions computed after it lands —
            nothing about already-settled ledger history is ever touched. Any{' '}
            <code className="text-[var(--foreground)]/80">_bps</code> take-rate requires a{' '}
            <Link
              href="/dashboard/pending-actions"
              className="text-[var(--accent)] hover:underline"
            >
              different admin&apos;s approval
            </Link>{' '}
            before it applies.
          </p>
        </div>
        <Link
          href="/dashboard/pricing/history"
          className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)] hover:underline"
        >
          Change history →
        </Link>
      </div>

      {error && (
        <p className="mt-4 text-sm text-red-400">Could not load pricing config: {error.message}</p>
      )}

      <div className="mt-6 space-y-8">
        {orderedLabels.map((label) => (
          <section key={label}>
            <h2 className="text-sm font-medium text-[var(--foreground)]/80">{label}</h2>
            <div className="mt-2 divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--surface)]">
              {grouped.get(label)!.map((row) => {
                const hint = pricingValueHint(row.key, row.value, row.currency);
                const activeProposal = activeProposalByKey.get(`${row.key}:${row.currency}`);
                return (
                  <div
                    key={`${row.key}:${row.currency}`}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <div>
                      <p className="text-sm font-medium text-[var(--foreground)]">
                        {row.key}{' '}
                        <span className="text-xs text-[var(--foreground)]/40">
                          ({row.currency})
                        </span>
                      </p>
                      {row.description && (
                        <p className="mt-1 max-w-xl text-xs text-[var(--foreground)]/60">
                          {row.description}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-[var(--foreground)]/40">
                        Updated {new Date(row.updated_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {hint && <span className="text-xs text-[var(--foreground)]/60">{hint}</span>}
                      {activeProposal ? (
                        <div className="rounded border border-[var(--border)] px-3 py-1.5 text-right text-xs text-[var(--foreground)]/70">
                          <p>
                            {activeProposal.status === 'approved'
                              ? 'Approved — ready to apply'
                              : 'Pending approval'}
                            {' → '}
                            {activeProposal.payload.new_value}
                          </p>
                          <Link
                            href="/dashboard/pending-actions"
                            className="text-[var(--accent)] hover:underline"
                          >
                            View in queue →
                          </Link>
                        </div>
                      ) : (
                        <PricingConfigForm
                          configKey={row.key}
                          currency={row.currency}
                          currentValue={row.value}
                          isMaterial={isMaterialKey(row.key)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {rows.length === 0 && !error && (
          <p className="py-6 text-center text-sm text-[var(--foreground)]/60">
            No pricing config keys found.
          </p>
        )}
      </div>
    </main>
  );
}
