import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { encodeCursor, decodeCursor, cursorFilter } from '@/lib/pagination';
import { ResolveForm, FreezeForm } from './actions-forms';

const PAGE_SIZE = 25;

type FraudSignal = {
  id: string;
  user_id: string | null;
  related_user_id: string | null;
  signal_type: string;
  severity: string;
  metadata: Record<string, unknown>;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolution_note: string | null;
};

export default async function FraudSignalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    cursor?: string;
    signal_type?: string;
    severity?: string;
    status?: string;
  }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'view_reports_queue');
  if (!allowed) redirect('/dashboard');

  const canResolve = await checkPermission(admin.id, 'resolve_fraud_signal');

  const params = await searchParams;
  const cursor = decodeCursor(params.cursor);
  const status = params.status ?? 'unresolved';

  const [{ data: signalTypes }, { data: signals, error: signalsError }] = await Promise.all([
    db().from('fraud_signals').select('signal_type').limit(1000),
    (() => {
      let query = db()
        .from('fraud_signals')
        .select(
          'id, user_id, related_user_id, signal_type, severity, metadata, created_at, resolved_at, resolution, resolution_note',
        )
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE + 1);

      if (status === 'unresolved') query = query.is('resolved_at', null);
      else if (status === 'resolved') query = query.not('resolved_at', 'is', null);
      if (params.signal_type) query = query.eq('signal_type', params.signal_type);
      if (params.severity) query = query.eq('severity', params.severity);
      if (cursor) query = query.or(cursorFilter(cursor));

      return query;
    })(),
  ]);

  const distinctSignalTypes = Array.from(
    new Set((signalTypes ?? []).map((r) => r.signal_type as string)),
  ).sort();

  const rows = (signals ?? []) as FraudSignal[];
  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasNextPage && lastRow ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.id }) : null;

  const userIds = Array.from(
    new Set(
      pageRows.flatMap((r) => [r.user_id, r.related_user_id]).filter((v): v is string => !!v),
    ),
  );
  const { data: users } = userIds.length
    ? await db().from('users').select('id, display_name, phone').in('id', userIds)
    : { data: [] as { id: string; display_name: string | null; phone: string | null }[] };
  const userById = new Map((users ?? []).map((u) => [u.id, u]));

  function userLabel(id: string | null): string {
    if (!id) return '—';
    const u = userById.get(id);
    if (!u) return id;
    return u.display_name ?? u.phone ?? id;
  }

  const baseParams = {
    ...(params.signal_type ? { signal_type: params.signal_type } : {}),
    ...(params.severity ? { severity: params.severity } : {}),
    status,
  };

  return (
    <main className="p-8">
      <h1 className="text-lg font-semibold text-[var(--foreground)]">Fraud signals</h1>
      <p className="mt-1 text-sm text-[var(--foreground)]/60">
        No auto-action ever fires from this queue — every dismiss, escalate, or freeze is a real
        click by a human.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-center gap-2">
        <select
          name="status"
          defaultValue={status}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="unresolved">Unresolved</option>
          <option value="resolved">Resolved</option>
          <option value="all">All</option>
        </select>
        <select
          name="signal_type"
          defaultValue={params.signal_type ?? ''}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="">All signal types</option>
          {distinctSignalTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          name="severity"
          defaultValue={params.severity ?? ''}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="">All severities</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white"
        >
          Filter
        </button>
      </form>

      {signalsError && (
        <p className="mt-4 text-sm text-red-400">
          Could not load fraud signals: {signalsError.message}
        </p>
      )}

      <div className="mt-6 space-y-3">
        {pageRows.map((signal) => (
          <div
            key={signal.id}
            className="rounded border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">
                  {signal.signal_type}{' '}
                  <span
                    className={
                      signal.severity === 'high'
                        ? 'text-red-400'
                        : signal.severity === 'medium'
                          ? 'text-yellow-400'
                          : 'text-[var(--foreground)]/60'
                    }
                  >
                    ({signal.severity})
                  </span>
                </p>
                <p className="mt-1 text-xs text-[var(--foreground)]/60">
                  User:{' '}
                  {signal.user_id ? (
                    <Link href={`/dashboard/users/${signal.user_id}`} className="hover:underline">
                      {userLabel(signal.user_id)}
                    </Link>
                  ) : (
                    '—'
                  )}
                  {signal.related_user_id && (
                    <>
                      {' '}
                      · Related:{' '}
                      <Link
                        href={`/dashboard/users/${signal.related_user_id}`}
                        className="hover:underline"
                      >
                        {userLabel(signal.related_user_id)}
                      </Link>
                    </>
                  )}
                </p>
                <p className="mt-1 text-xs text-[var(--foreground)]/60">
                  {new Date(signal.created_at).toLocaleString()}
                </p>
                <pre className="mt-2 whitespace-pre-wrap text-xs text-[var(--foreground)]/60">
                  {JSON.stringify(signal.metadata, null, 0)}
                </pre>
                {signal.resolved_at && (
                  <p className="mt-2 text-xs text-[var(--foreground)]/60">
                    Resolved as <span className="font-medium">{signal.resolution}</span> —{' '}
                    {new Date(signal.resolved_at).toLocaleString()}
                    {signal.resolution_note && `: "${signal.resolution_note}"`}
                  </p>
                )}
              </div>

              {canResolve && !signal.resolved_at && (
                <div className="flex flex-col gap-2">
                  <ResolveForm signalId={signal.id} />
                  {signal.user_id && <FreezeForm userId={signal.user_id} />}
                </div>
              )}
            </div>
          </div>
        ))}
        {pageRows.length === 0 && !signalsError && (
          <p className="py-6 text-center text-sm text-[var(--foreground)]/60">No signals match.</p>
        )}
      </div>

      {nextCursor && (
        <Link
          href={`/dashboard/fraud-signals?${new URLSearchParams({ ...baseParams, cursor: nextCursor }).toString()}`}
          className="mt-6 inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
