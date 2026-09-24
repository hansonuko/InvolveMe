import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { ProposeStrategyChangeForm } from './actions-forms';

type StrategyRow = {
  currency: string;
  active_strategy: string;
  updated_at: string;
  updated_by_admin_id: string | null;
};

type PendingChange = {
  id: string;
  status: string;
  payload: { currency?: string; active_strategy?: string };
};

const STRATEGY_LABELS: Record<string, string> = {
  tiered_word_block: 'Tiered word block',
  flat_per_message: 'Flat per message',
  linear_per_word: 'Linear per word',
};

const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  tiered_word_block:
    'base credits × ceil(words / block size) — the live default. Tune message_base_credits / message_word_block_size in the pricing editor.',
  flat_per_message:
    'a fixed credit cost per message regardless of length, still bounded by message_max_words. Tune message_flat_credits in the pricing editor.',
  linear_per_word:
    'credits scale with length: credits per 100 words, rounded up. Tune message_credits_per_100_words in the pricing editor.',
};

export default async function MessagePricingStrategyPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'edit_pricing_config');
  if (!allowed) redirect('/dashboard');

  const [{ data: strategyRows, error: strategyError }, { data: pendingRows }] = await Promise.all([
    db()
      .from('message_pricing_strategy')
      .select('currency, active_strategy, updated_at, updated_by_admin_id')
      .order('currency'),
    // Bounded — pending/approved message_pricing_strategy_change rows are
    // never numerous, same reasoning as every other "active proposal"
    // lookup this dashboard already does.
    db()
      .from('admin_pending_actions')
      .select('id, status, payload')
      .eq('action_type', 'message_pricing_strategy_change')
      .in('status', ['pending', 'approved']),
  ]);

  const rows = (strategyRows ?? []) as StrategyRow[];

  const activeChangeByCurrency = new Map<string, PendingChange>();
  for (const p of (pendingRows ?? []) as PendingChange[]) {
    if (p.payload?.currency) activeChangeByCurrency.set(p.payload.currency, p);
  }

  const adminIds = Array.from(
    new Set(rows.map((r) => r.updated_by_admin_id).filter((v): v is string => !!v)),
  );
  const { data: admins } = adminIds.length
    ? await db().from('admin_users').select('id, email').in('id', adminIds)
    : { data: [] as { id: string; email: string }[] };
  const adminEmailById = new Map((admins ?? []).map((a) => [a.id, a.email]));

  return (
    <main className="p-8">
      <Link
        href="/dashboard/pricing"
        className="text-sm text-[var(--foreground)]/60 hover:underline"
      >
        ← Pricing config
      </Link>

      <h1 className="mt-2 text-lg font-semibold text-[var(--foreground)]">
        Message pricing strategy
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--foreground)]/60">
        Switches which formula computes a message&apos;s cost — not just retuning numbers within one
        fixed formula. Always requires a different admin&apos;s approval, no exceptions, even though
        other pricing changes on this key don&apos;t always need it — a strategy switch changes the
        fundamental shape of the anti-abuse economics, not just a rate.
      </p>

      {strategyError && (
        <p className="mt-4 text-sm text-red-400">
          Could not load message pricing strategy: {strategyError.message}
        </p>
      )}

      <div className="mt-6 divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--surface)]">
        {rows.map((row) => {
          const activeChange = activeChangeByCurrency.get(row.currency);
          return (
            <div
              key={row.currency}
              className="flex flex-wrap items-center justify-between gap-3 p-4"
            >
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">
                  {row.currency}: {STRATEGY_LABELS[row.active_strategy] ?? row.active_strategy}
                </p>
                <p className="mt-1 max-w-xl text-xs text-[var(--foreground)]/60">
                  {STRATEGY_DESCRIPTIONS[row.active_strategy] ?? ''}
                </p>
                <p className="mt-1 text-xs text-[var(--foreground)]/40">
                  Last changed by{' '}
                  {row.updated_by_admin_id
                    ? (adminEmailById.get(row.updated_by_admin_id) ?? row.updated_by_admin_id)
                    : 'system (seed)'}{' '}
                  — {new Date(row.updated_at).toLocaleString()}
                </p>
              </div>

              <div className="flex flex-col items-end gap-1">
                {activeChange ? (
                  <div className="rounded border border-[var(--border)] px-3 py-1.5 text-right text-xs text-[var(--foreground)]/70">
                    <p>
                      {activeChange.status === 'approved'
                        ? 'Approved — ready to apply'
                        : 'Pending approval'}
                      {' → '}
                      {STRATEGY_LABELS[activeChange.payload.active_strategy ?? ''] ??
                        activeChange.payload.active_strategy}
                    </p>
                    <Link
                      href="/dashboard/pending-actions"
                      className="text-[var(--accent)] hover:underline"
                    >
                      View in queue →
                    </Link>
                  </div>
                ) : (
                  <ProposeStrategyChangeForm
                    currency={row.currency}
                    currentStrategy={row.active_strategy}
                  />
                )}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && !strategyError && (
          <p className="p-4 text-sm text-[var(--foreground)]/60">
            No currencies configured for message pricing yet.
          </p>
        )}
      </div>
    </main>
  );
}
