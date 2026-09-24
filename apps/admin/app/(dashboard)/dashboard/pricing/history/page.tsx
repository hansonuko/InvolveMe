import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { encodeCursor, decodeCursor, cursorFilter } from '@/lib/pagination';

const PAGE_SIZE = 50;

type HistoryRow = {
  id: string;
  key: string;
  currency: string;
  old_value: number | null;
  new_value: number;
  changed_by: string;
  changed_at: string;
};

export default async function PricingHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; key?: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'edit_pricing_config');
  if (!allowed) redirect('/dashboard');

  const params = await searchParams;
  const cursor = decodeCursor(params.cursor);

  const [{ data: keyRows }, { data, error }] = await Promise.all([
    db().from('pricing_config').select('key').order('key'),
    (() => {
      let query = db()
        .from('pricing_config_history')
        .select('id, key, currency, old_value, new_value, changed_by, changed_at')
        .order('changed_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE + 1);

      if (params.key) query = query.eq('key', params.key);
      // pricing_config_history's timestamp column is changed_at, not the
      // created_at every other cursor-paginated page in this app uses —
      // cursorFilter takes the column name explicitly for exactly this case.
      if (cursor) query = query.or(cursorFilter(cursor, 'changed_at'));

      return query;
    })(),
  ]);

  const distinctKeys = Array.from(new Set((keyRows ?? []).map((r) => r.key as string))).sort();
  const rows = (data ?? []) as HistoryRow[];
  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasNextPage && lastRow ? encodeCursor({ createdAt: lastRow.changed_at, id: lastRow.id }) : null;

  return (
    <main className="p-8">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--foreground)]">
          Pricing config — change history
        </h1>
        <Link
          href="/dashboard/pricing"
          className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)] hover:underline"
        >
          ← Back to pricing
        </Link>
      </div>

      <form method="get" className="mt-4 flex flex-wrap items-center gap-2">
        <select
          name="key"
          defaultValue={params.key ?? ''}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="">All keys</option>
          {distinctKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-[var(--on-accent)]"
        >
          Filter
        </button>
      </form>

      {error && (
        <p className="mt-4 text-sm text-[var(--danger)]">
          Could not load change history: {error.message}
        </p>
      )}

      <div className="mt-6 overflow-x-auto rounded border border-[var(--border)]">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
            <tr>
              <th className="p-3">Key</th>
              <th className="p-3">Old value</th>
              <th className="p-3">New value</th>
              <th className="p-3">Changed by</th>
              <th className="p-3">When</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr key={row.id} className="border-b border-[var(--border)] last:border-0">
                <td className="p-3 text-[var(--foreground)]">
                  {row.key}{' '}
                  <span className="text-xs text-[var(--foreground)]/40">({row.currency})</span>
                </td>
                <td className="p-3 text-[var(--foreground)]/70">{row.old_value ?? '—'}</td>
                <td className="p-3 text-[var(--foreground)]/70">{row.new_value}</td>
                <td className="p-3 text-[var(--foreground)]/70">{row.changed_by}</td>
                <td className="p-3 text-[var(--foreground)]/60">
                  {new Date(row.changed_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {pageRows.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-sm text-[var(--foreground)]/60">
                  No changes recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <Link
          href={`/dashboard/pricing/history?${new URLSearchParams({
            ...(params.key ? { key: params.key } : {}),
            cursor: nextCursor,
          }).toString()}`}
          className="mt-6 inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)]"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
