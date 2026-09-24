import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';

type CountryStatRow = {
  country: string;
  user_count: number;
};

const COUNTRY_LABELS: Record<string, string> = {
  NG: 'Nigeria',
  UNKNOWN: 'Unknown',
};

export default async function UserLocationStatsPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'view_users');
  if (!allowed) redirect('/dashboard');

  // Aggregated server-side by users_country_stats (a Postgres view over
  // users, grouped by country) — never fetched raw and counted here, same
  // discipline docs/14 §8 requires for every chart in this dashboard.
  const { data, error } = await db().from('users_country_stats').select('country, user_count');

  const rows = ((data ?? []) as CountryStatRow[])
    .slice()
    .sort((a, b) => b.user_count - a.user_count);
  const total = rows.reduce((sum, r) => sum + r.user_count, 0);
  const unknownCount = rows.find((r) => r.country === 'UNKNOWN')?.user_count ?? 0;

  return (
    <main className="p-8">
      <Link href="/dashboard/users" className="text-sm text-[var(--foreground)]/60 hover:underline">
        ← Users
      </Link>

      <h1 className="mt-2 text-lg font-semibold text-[var(--foreground)]">User location stats</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--foreground)]/60">
        A live count grouped by each user&apos;s own onboarding-confirmed country — not an estimate.
        Users who signed up before country capture existed (or haven&apos;t completed onboarding)
        show as <span className="font-medium">Unknown</span> rather than being guessed at.
      </p>

      {error && (
        <p className="mt-4 text-sm text-red-400">Could not load location stats: {error.message}</p>
      )}

      {!error && (
        <div className="mt-6 max-w-2xl rounded border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-baseline justify-between text-xs text-[var(--foreground)]/60">
            <span>{total.toLocaleString()} users total</span>
            {total > 0 && (
              <span>
                {unknownCount.toLocaleString()} unknown ({Math.round((unknownCount / total) * 100)}
                %)
              </span>
            )}
          </div>

          <div className="mt-4 flex flex-col gap-3">
            {rows.map((row) => {
              const pct = total > 0 ? (row.user_count / total) * 100 : 0;
              return (
                <div key={row.country}>
                  <div className="flex items-baseline justify-between text-sm text-[var(--foreground)]">
                    <span>{COUNTRY_LABELS[row.country] ?? row.country}</span>
                    <span className="text-[var(--foreground)]/60">
                      {row.user_count.toLocaleString()} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded bg-[var(--border)]">
                    <div
                      className="h-full rounded bg-[var(--accent)]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && (
              <p className="text-sm text-[var(--foreground)]/60">No users yet.</p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
