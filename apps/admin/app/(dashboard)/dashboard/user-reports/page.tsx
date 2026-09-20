import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { encodeCursor, decodeCursor, cursorFilter } from '@/lib/pagination';
import { ResolveReportForm } from './actions-forms';

const PAGE_SIZE = 25;

type UserReport = {
  id: string;
  reporter_id: string;
  reported_user_id: string;
  thread_id: string | null;
  reason: string;
  details: string | null;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolution_note: string | null;
};

export default async function UserReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; reason?: string; status?: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'view_reports_queue');
  if (!allowed) redirect('/dashboard');

  const canResolve = await checkPermission(admin.id, 'resolve_user_report');

  const params = await searchParams;
  const cursor = decodeCursor(params.cursor);
  const status = params.status ?? 'unresolved';

  const [{ data: reasons }, { data: reports, error: reportsError }] = await Promise.all([
    db().from('user_reports').select('reason').limit(1000),
    (() => {
      let query = db()
        .from('user_reports')
        .select(
          'id, reporter_id, reported_user_id, thread_id, reason, details, created_at, resolved_at, resolution, resolution_note',
        )
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(PAGE_SIZE + 1);

      if (status === 'unresolved') query = query.is('resolved_at', null);
      else if (status === 'resolved') query = query.not('resolved_at', 'is', null);
      if (params.reason) query = query.eq('reason', params.reason);
      if (cursor) query = query.or(cursorFilter(cursor));

      return query;
    })(),
  ]);

  const distinctReasons = Array.from(
    new Set((reasons ?? []).map((r) => r.reason as string)),
  ).sort();

  const rows = (reports ?? []) as UserReport[];
  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasNextPage && lastRow ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.id }) : null;

  const userIds = Array.from(
    new Set(pageRows.flatMap((r) => [r.reporter_id, r.reported_user_id]).filter(Boolean)),
  );
  const { data: users } = userIds.length
    ? await db().from('users').select('id, display_name, phone').in('id', userIds)
    : { data: [] as { id: string; display_name: string | null; phone: string | null }[] };
  const userById = new Map((users ?? []).map((u) => [u.id, u]));

  function userLabel(id: string): string {
    const u = userById.get(id);
    if (!u) return id;
    return u.display_name ?? u.phone ?? id;
  }

  const baseParams = { ...(params.reason ? { reason: params.reason } : {}), status };

  return (
    <main className="p-8">
      <h1 className="text-lg font-semibold text-[var(--foreground)]">User reports</h1>
      <p className="mt-1 text-sm text-[var(--foreground)]/60">
        Every resolution — warn, suspend, ban, or dismiss — is a real click by a human, logged to
        the audit trail.
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
          name="reason"
          defaultValue={params.reason ?? ''}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="">All reasons</option>
          {distinctReasons.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="rounded bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white"
        >
          Filter
        </button>
      </form>

      {reportsError && (
        <p className="mt-4 text-sm text-red-400">
          Could not load user reports: {reportsError.message}
        </p>
      )}

      <div className="mt-6 space-y-3">
        {pageRows.map((report) => (
          <div
            key={report.id}
            className="rounded border border-[var(--border)] bg-[var(--surface)] p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">{report.reason}</p>
                <p className="mt-1 text-xs text-[var(--foreground)]/60">
                  Reported:{' '}
                  <Link
                    href={`/dashboard/users/${report.reported_user_id}`}
                    className="hover:underline"
                  >
                    {userLabel(report.reported_user_id)}
                  </Link>
                  {' · Reporter: '}
                  <Link href={`/dashboard/users/${report.reporter_id}`} className="hover:underline">
                    {userLabel(report.reporter_id)}
                  </Link>
                  {/* No admin thread-viewer page exists yet (only a placeholder in Phase C's own scope), so this is
                      plain text, not a link — a link to a nonexistent page would be a dead one. */}
                  {report.thread_id && (
                    <span className="text-[var(--foreground)]/40">
                      {' '}
                      · thread {report.thread_id}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-xs text-[var(--foreground)]/60">
                  {new Date(report.created_at).toLocaleString()}
                </p>
                {report.details && (
                  <p className="mt-2 text-sm text-[var(--foreground)]">{report.details}</p>
                )}
                {report.resolved_at && (
                  <p className="mt-2 text-xs text-[var(--foreground)]/60">
                    Resolved as <span className="font-medium">{report.resolution}</span> —{' '}
                    {new Date(report.resolved_at).toLocaleString()}
                    {report.resolution_note && `: "${report.resolution_note}"`}
                  </p>
                )}
              </div>

              {canResolve && !report.resolved_at && <ResolveReportForm reportId={report.id} />}
            </div>
          </div>
        ))}
        {pageRows.length === 0 && !reportsError && (
          <p className="py-6 text-center text-sm text-[var(--foreground)]/60">No reports match.</p>
        )}
      </div>

      {nextCursor && (
        <Link
          href={`/dashboard/user-reports?${new URLSearchParams({ ...baseParams, cursor: nextCursor }).toString()}`}
          className="mt-6 inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
