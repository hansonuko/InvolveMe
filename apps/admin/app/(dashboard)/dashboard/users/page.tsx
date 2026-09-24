import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { encodeCursor, decodeCursor, cursorFilter, sanitizeSearchTerm } from '@/lib/pagination';
import { EXPORT_ROW_CAP } from '@/lib/csv';

const PAGE_SIZE = 25;

type UserRow = {
  id: string;
  phone: string | null;
  display_name: string | null;
  kyc_tier: number;
  is_suspended: boolean;
  country: string | null;
  created_at: string;
};

export default async function UsersListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cursor?: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'view_users');
  if (!allowed) redirect('/dashboard');

  const params = await searchParams;
  const q = sanitizeSearchTerm(params.q ?? '');
  const cursor = decodeCursor(params.cursor);

  let query = db()
    .from('users')
    .select('id, phone, display_name, kyc_tier, is_suspended, country, created_at')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (q) {
    query = query.or(`phone.ilike.%${q}%,display_name.ilike.%${q}%`);
  }
  if (cursor) {
    query = query.or(cursorFilter(cursor));
  }

  // Same q filter as the paginated query above, no cursor — this is a
  // count of everything CSV export would need to fetch, checked before
  // offering the link at all (docs/14 §8: a hard cap, never a synchronous
  // "export everything" button that can time out or take the database
  // with it — see lib/csv.ts's own comment for why this stays synchronous
  // rather than the doc's literal "async job" wording).
  let countQuery = db().from('users').select('id', { count: 'exact', head: true });
  if (q) countQuery = countQuery.or(`phone.ilike.%${q}%,display_name.ilike.%${q}%`);

  const [{ data, error }, { count: matchingCount }] = await Promise.all([query, countQuery]);
  const rows = (data ?? []) as UserRow[];
  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasNextPage && lastRow ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.id }) : null;
  const canExport = (matchingCount ?? 0) > 0 && (matchingCount ?? 0) <= EXPORT_ROW_CAP;

  return (
    <main className="p-8">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h1 className="text-lg font-semibold text-[var(--foreground)]">Users</h1>
        <Link
          href="/dashboard/users/analytics"
          className="text-sm text-[var(--foreground)]/70 hover:text-[var(--foreground)] hover:underline"
        >
          Location stats →
        </Link>
      </div>

      <form method="get" className="mt-4 max-w-sm">
        <input
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Search by phone or name"
          className="w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 text-sm text-[var(--foreground)]"
        />
      </form>

      <p className="mt-3 text-xs text-[var(--foreground)]/60">
        {canExport ? (
          <a
            href={`/api/export/users${q ? `?q=${encodeURIComponent(q)}` : ''}`}
            className="text-[var(--accent)] hover:underline"
          >
            Export {matchingCount?.toLocaleString()} matching{' '}
            {matchingCount === 1 ? 'user' : 'users'} to CSV →
          </a>
        ) : (matchingCount ?? 0) > EXPORT_ROW_CAP ? (
          <>
            {matchingCount?.toLocaleString()} users match — narrow your search to enable CSV export
            (cap: {EXPORT_ROW_CAP.toLocaleString()}).
          </>
        ) : null}
      </p>

      {error && (
        <p className="mt-4 text-sm text-[var(--danger)]">Could not load users: {error.message}</p>
      )}

      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-left text-sm text-[var(--foreground)]">
          <thead>
            <tr className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
              <th className="pb-2 pr-4 font-medium">Name</th>
              <th className="pb-2 pr-4 font-medium">Phone</th>
              <th className="pb-2 pr-4 font-medium">KYC tier</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">Country</th>
              <th className="pb-2 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => (
              <tr key={row.id} className="border-b border-[var(--border)]/50">
                <td className="py-2 pr-4">
                  <Link href={`/dashboard/users/${row.id}`} className="hover:underline">
                    {row.display_name ?? '—'}
                  </Link>
                </td>
                <td className="py-2 pr-4">{row.phone ?? '—'}</td>
                <td className="py-2 pr-4">{row.kyc_tier}</td>
                <td className="py-2 pr-4">{row.is_suspended ? 'Suspended' : 'Active'}</td>
                <td className="py-2 pr-4">{row.country ?? 'Unknown'}</td>
                <td className="py-2 text-[var(--foreground)]/60">
                  {new Date(row.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {pageRows.length === 0 && !error && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[var(--foreground)]/60">
                  No users match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <Link
          href={`/dashboard/users?${new URLSearchParams({ ...(q ? { q } : {}), cursor: nextCursor }).toString()}`}
          className="mt-6 inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)]"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
