import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { formatWalletAmount, WALLET_KIND_LABELS } from '@/lib/money';

const DAILY_TOTALS_WINDOW_DAYS = 30;

type PlatformWallet = {
  id: string;
  kind: string;
  currency: string;
  balance: number;
  updated_at: string;
};

type DailyTotal = {
  wallet_id: string;
  kind: string;
  currency: string;
  day: string;
  net_amount: number;
};

const REVENUE_KINDS = ['platform_revenue_topup_fees', 'platform_revenue_earnings_cut'];
const RESERVE_KINDS = ['platform_reserve_topup_fees', 'platform_reserve_earnings_cut'];

// A plain helper, not inlined in the component body — eslint's react-hooks
// purity rule flags Date.now() directly inside a component/hook, even
// though that concern (unstable results across re-renders) doesn't really
// apply to a Server Component computing a value once per request.
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default async function TreasuryPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'view_treasury');
  if (!allowed) redirect('/dashboard');

  const since = daysAgoIso(DAILY_TOTALS_WINDOW_DAYS);

  const [{ data: wallets, error: walletsError }, { data: dailyTotals, error: dailyError }] =
    await Promise.all([
      db()
        .from('wallets')
        .select('id, kind, currency, balance, updated_at')
        .is('user_id', null)
        .order('currency')
        .order('kind'),
      db()
        .from('platform_wallet_daily_totals')
        .select('wallet_id, kind, currency, day, net_amount')
        .gte('day', since)
        .order('day', { ascending: false })
        .order('kind'),
    ]);

  const walletRows = (wallets ?? []) as PlatformWallet[];
  const dailyRows = (dailyTotals ?? []) as DailyTotal[];

  const byCurrency = new Map<string, PlatformWallet[]>();
  for (const w of walletRows) {
    const list = byCurrency.get(w.currency) ?? [];
    list.push(w);
    byCurrency.set(w.currency, list);
  }

  return (
    <main className="p-8">
      <h1 className="text-lg font-semibold text-[var(--foreground)]">Treasury</h1>
      <p className="mt-1 text-sm text-[var(--foreground)]/60">
        Manual refresh — reload the page for the latest figures. Every number here is the real
        ledger state, not a cached or estimated one.
      </p>

      {walletsError && (
        <p className="mt-4 text-sm text-red-400">
          Could not load platform wallets: {walletsError.message}
        </p>
      )}

      {Array.from(byCurrency.entries()).map(([currency, currencyWallets]) => (
        <section key={currency} className="mt-8">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">{currency}</h2>

          <div className="mt-3">
            <p className="text-xs font-medium text-[var(--foreground)]/60">Revenue (spendable)</p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {currencyWallets
                .filter((w) => REVENUE_KINDS.includes(w.kind))
                .map((w) => (
                  <WalletCard key={w.id} wallet={w} />
                ))}
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs font-medium text-[var(--foreground)]/60">
              Reserve (chargeback self-insurance buffer — not spendable revenue)
            </p>
            <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {currencyWallets
                .filter((w) => RESERVE_KINDS.includes(w.kind))
                .map((w) => (
                  <WalletCard key={w.id} wallet={w} />
                ))}
            </div>
          </div>
        </section>
      ))}

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">
          Daily activity, last {DAILY_TOTALS_WINDOW_DAYS} days
        </h2>
        <p className="mt-1 text-xs text-[var(--foreground)]/60">
          Aggregated server-side (a Postgres view over ledger_entries) — never fetched raw and
          summed here.
        </p>

        {dailyError && (
          <p className="mt-2 text-sm text-red-400">
            Could not load daily totals: {dailyError.message}
          </p>
        )}

        <table className="mt-3 w-full text-left text-sm text-[var(--foreground)]">
          <thead>
            <tr className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
              <th className="pb-2 pr-4 font-medium">Day</th>
              <th className="pb-2 pr-4 font-medium">Wallet</th>
              <th className="pb-2 font-medium">Net change</th>
            </tr>
          </thead>
          <tbody>
            {dailyRows.map((row) => (
              <tr
                key={`${row.wallet_id}-${row.day}`}
                className="border-b border-[var(--border)]/50"
              >
                <td className="py-2 pr-4">{new Date(row.day).toLocaleDateString()}</td>
                <td className="py-2 pr-4">{WALLET_KIND_LABELS[row.kind] ?? row.kind}</td>
                <td className="py-2">
                  {formatWalletAmount(row.net_amount, row.kind, row.currency)}
                </td>
              </tr>
            ))}
            {dailyRows.length === 0 && !dailyError && (
              <tr>
                <td colSpan={3} className="py-6 text-center text-[var(--foreground)]/60">
                  No activity in the last {DAILY_TOTALS_WINDOW_DAYS} days.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Platform withdrawals</h2>
        <p className="mt-2 text-sm text-[var(--foreground)]/60">
          No withdrawal-from-platform capability exists yet — this is Phase F
          (docs/14-ADMIN-DASHBOARD-SCOPING.md §5), gated behind dual-approval with no materiality
          floor. Nothing to show here until that phase ships.
        </p>
      </section>
    </main>
  );
}

function WalletCard({ wallet }: { wallet: PlatformWallet }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs text-[var(--foreground)]/60">
        {WALLET_KIND_LABELS[wallet.kind] ?? wallet.kind}
      </p>
      <p className="mt-1 text-lg font-semibold text-[var(--foreground)]">
        {formatWalletAmount(wallet.balance, wallet.kind, wallet.currency)}
      </p>
    </div>
  );
}
