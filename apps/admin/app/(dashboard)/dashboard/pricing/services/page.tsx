import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { SERVICE_PRICING_REGISTRY } from '@/lib/servicePricing';
import { ServiceToggleForm } from './actions-forms';

type PricingConfigRow = { key: string; currency: string; value: number };
type HistoryRow = { key: string; currency: string; changed_by: string; changed_at: string };

export default async function ServicePricingPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  // Same gate as the main pricing editor this page is a curated view
  // over — no separate view_pricing_config permission exists (confirmed
  // directly, per the main pricing page's own comment).
  const allowed = await checkPermission(admin.id, 'edit_pricing_config');
  if (!allowed) redirect('/dashboard');

  const keys = SERVICE_PRICING_REGISTRY.map((s) => s.configKey);

  const [{ data: configRows, error: configError }, { data: historyRows }] = await Promise.all([
    db().from('pricing_config').select('key, currency, value').in('key', keys),
    db()
      .from('pricing_config_history')
      .select('key, currency, changed_by, changed_at')
      .in('key', keys)
      .order('changed_at', { ascending: false }),
  ]);

  const valueByKeyCurrency = new Map(
    ((configRows ?? []) as PricingConfigRow[]).map((r) => [`${r.key}:${r.currency}`, r.value]),
  );

  // History rows are fetched newest-first, so the first occurrence per
  // key/currency pair encountered here is the most recent change.
  const lastChangeByKeyCurrency = new Map<string, HistoryRow>();
  for (const row of (historyRows ?? []) as HistoryRow[]) {
    const id = `${row.key}:${row.currency}`;
    if (!lastChangeByKeyCurrency.has(id)) lastChangeByKeyCurrency.set(id, row);
  }

  return (
    <main className="p-8">
      <Link
        href="/dashboard/pricing"
        className="text-sm text-[var(--foreground)]/60 hover:underline"
      >
        ← Pricing config
      </Link>

      <h1 className="mt-2 text-lg font-semibold text-[var(--foreground)]">Service pricing</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--foreground)]/60">
        Every existing free-vs-charged kill-switch in one place, instead of hunting for it in the
        full config key list. A new per-service toggle lands here by being added to this list — see{' '}
        <code className="text-[var(--foreground)]/80">lib/servicePricing.ts</code>.
      </p>

      {configError && (
        <p className="mt-4 text-sm text-red-400">
          Could not load service pricing: {configError.message}
        </p>
      )}

      <div className="mt-6 divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--surface)]">
        {SERVICE_PRICING_REGISTRY.map((entry) => {
          const id = `${entry.configKey}:${entry.currency}`;
          const value = valueByKeyCurrency.get(id);
          const lastChange = lastChangeByKeyCurrency.get(id);
          const isEnabled = value === 1;

          return (
            <div key={id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">
                  {entry.serviceName}{' '}
                  <span className="text-xs text-[var(--foreground)]/40">({entry.currency})</span>
                </p>
                <p className="mt-1 max-w-xl text-xs text-[var(--foreground)]/60">
                  {entry.description}
                </p>
                {lastChange && (
                  <p className="mt-1 text-xs text-[var(--foreground)]/40">
                    Last changed by {lastChange.changed_by} —{' '}
                    {new Date(lastChange.changed_at).toLocaleString()}
                  </p>
                )}
              </div>

              <div className="flex flex-col items-end gap-1">
                <span
                  className={
                    isEnabled
                      ? 'text-xs font-medium text-[var(--accent)]'
                      : 'text-xs font-medium text-[var(--foreground)]/60'
                  }
                >
                  {value === undefined ? 'Unknown' : isEnabled ? 'Enabled (charged)' : 'Disabled'}
                </span>
                {value !== undefined && (
                  <ServiceToggleForm
                    configKey={entry.configKey}
                    currency={entry.currency}
                    currentValue={value}
                  />
                )}
              </div>
            </div>
          );
        })}
        {SERVICE_PRICING_REGISTRY.length === 0 && (
          <p className="p-4 text-sm text-[var(--foreground)]/60">
            No service pricing toggles registered.
          </p>
        )}
      </div>
    </main>
  );
}
