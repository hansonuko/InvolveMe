import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { formatWalletAmount, formatKobo, WALLET_KIND_LABELS } from '@/lib/money';
import { loadFlutterwaveConfig } from '@/lib/flutterwave';
import { createFlutterwaveProvider } from '@involveme/payments';
import {
  ConvertEarningsForm,
  RegisterBankAccountForm,
  DeactivateBankAccountForm,
  ProposeWithdrawalForm,
} from './actions-forms';

const DAILY_TOTALS_WINDOW_DAYS = 30;
const WITHDRAWAL_HISTORY_LIMIT = 20;

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

type PlatformBankAccount = {
  id: string;
  currency: string;
  bank_name: string;
  account_number_last4: string;
  account_name: string;
  label: string | null;
  is_active: boolean;
};

type PlatformWithdrawal = {
  id: string;
  currency: string;
  amount_minor: number;
  status: string;
  initiated_by_admin_id: string;
  platform_bank_account_id: string;
  created_at: string;
  completed_at: string | null;
};

const REVENUE_KINDS = ['platform_revenue_topup_fees', 'platform_revenue_earnings_cut'];
const RESERVE_KINDS = ['platform_reserve_topup_fees', 'platform_reserve_earnings_cut'];

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export default async function TreasuryPage() {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'view_treasury');
  if (!allowed) redirect('/dashboard');

  const canManageBankAccounts = await checkPermission(admin.id, 'manage_platform_bank_accounts');
  const canInitiateWithdrawal = await checkPermission(admin.id, 'initiate_platform_withdrawal');

  const since = daysAgoIso(DAILY_TOTALS_WINDOW_DAYS);

  const [
    { data: wallets, error: walletsError },
    { data: dailyTotals, error: dailyError },
    { data: bankAccounts, error: bankAccountsError },
    { data: withdrawals, error: withdrawalsError },
  ] = await Promise.all([
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
    db()
      .from('platform_bank_accounts')
      .select('id, currency, bank_name, account_number_last4, account_name, label, is_active')
      .order('currency')
      .order('is_active', { ascending: false }),
    db()
      .from('platform_withdrawals')
      .select(
        'id, currency, amount_minor, status, initiated_by_admin_id, platform_bank_account_id, created_at, completed_at',
      )
      .order('created_at', { ascending: false })
      .limit(WITHDRAWAL_HISTORY_LIMIT),
  ]);

  const walletRows = (wallets ?? []) as PlatformWallet[];
  const dailyRows = (dailyTotals ?? []) as DailyTotal[];
  const bankAccountRows = (bankAccounts ?? []) as PlatformBankAccount[];
  const withdrawalRows = (withdrawals ?? []) as PlatformWithdrawal[];

  const byCurrency = new Map<string, PlatformWallet[]>();
  const currencies = new Set<string>();
  for (const w of walletRows) {
    currencies.add(w.currency);
    const list = byCurrency.get(w.currency) ?? [];
    list.push(w);
    byCurrency.set(w.currency, list);
  }

  const bankAccountsByCurrency = new Map<string, PlatformBankAccount[]>();
  for (const b of bankAccountRows) {
    currencies.add(b.currency);
    const list = bankAccountsByCurrency.get(b.currency) ?? [];
    list.push(b);
    bankAccountsByCurrency.set(b.currency, list);
  }
  const bankAccountById = new Map(bankAccountRows.map((b) => [b.id, b]));

  const adminIds = Array.from(new Set(withdrawalRows.map((w) => w.initiated_by_admin_id)));
  const { data: admins } = adminIds.length
    ? await db().from('admin_users').select('id, email').in('id', adminIds)
    : { data: [] as { id: string; email: string }[] };
  const adminEmailById = new Map((admins ?? []).map((a) => [a.id, a.email]));

  // A real Flutterwave call — only made when this admin can actually
  // register a new destination, and only once per page load (never
  // per-row), avoiding a live API call for anyone who doesn't need it.
  let banks: { code: string; name: string }[] = [];
  let banksError: string | null = null;
  if (canManageBankAccounts) {
    try {
      banks = await createFlutterwaveProvider(loadFlutterwaveConfig()).listBanks();
    } catch (e) {
      banksError = e instanceof Error ? e.message : 'Could not load the bank list.';
    }
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

      {Array.from(byCurrency.entries()).map(([currency, currencyWallets]) => {
        const earningsCutWallet = currencyWallets.find(
          (w) => w.kind === 'platform_revenue_earnings_cut',
        );
        return (
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
              {canInitiateWithdrawal && earningsCutWallet && earningsCutWallet.balance > 0 && (
                <div className="mt-2">
                  <p className="text-xs text-[var(--foreground)]/60">
                    Earnings-cut revenue is credit-denominated — convert to cash before it can be
                    withdrawn:
                  </p>
                  <ConvertEarningsForm currency={currency} />
                </div>
              )}
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
        );
      })}

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
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Bank accounts</h2>
        <p className="mt-1 text-xs text-[var(--foreground)]/60">
          Company-owned payout destinations only. Registering a new one requires a different
          admin&apos;s approval; deactivating an existing one does not.
        </p>

        {bankAccountsError && (
          <p className="mt-2 text-sm text-red-400">
            Could not load bank accounts: {bankAccountsError.message}
          </p>
        )}

        <div className="mt-3 divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--surface)]">
          {bankAccountRows.map((b) => (
            <div key={b.id} className="flex items-center justify-between gap-3 p-4">
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">
                  {b.bank_name} •••• {b.account_number_last4}{' '}
                  <span className="text-xs text-[var(--foreground)]/40">({b.currency})</span>
                </p>
                <p className="mt-1 text-xs text-[var(--foreground)]/60">
                  {b.account_name}
                  {b.label && ` — ${b.label}`}
                </p>
                {!b.is_active && (
                  <p className="mt-1 text-xs font-medium text-[var(--foreground)]/40">Inactive</p>
                )}
              </div>
              {canManageBankAccounts && b.is_active && (
                <DeactivateBankAccountForm bankAccountId={b.id} />
              )}
            </div>
          ))}
          {bankAccountRows.length === 0 && !bankAccountsError && (
            <p className="p-4 text-sm text-[var(--foreground)]/60">No bank accounts registered.</p>
          )}
        </div>

        {canManageBankAccounts && (
          <div className="mt-4 space-y-3">
            {banksError && <p className="text-sm text-red-400">{banksError}</p>}
            {!banksError &&
              Array.from(currencies).map((currency) => (
                <RegisterBankAccountForm key={currency} currency={currency} banks={banks} />
              ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Withdrawals</h2>
        <p className="mt-1 text-xs text-[var(--foreground)]/60">
          Dual-approved, no materiality floor — every withdrawal needs a different admin&apos;s
          approval, proposed and approved from{' '}
          <Link href="/dashboard/pending-actions" className="text-[var(--accent)] hover:underline">
            Pending actions
          </Link>
          . Once approved, applying it here calls the payment provider directly.
        </p>

        {canInitiateWithdrawal && (
          <div className="mt-3 space-y-3">
            {Array.from(bankAccountsByCurrency.entries()).map(([currency, accounts]) => {
              const active = accounts.filter((a) => a.is_active);
              if (active.length === 0) return null;
              return (
                <ProposeWithdrawalForm
                  key={currency}
                  currency={currency}
                  bankAccounts={active.map((a) => ({
                    id: a.id,
                    label: `${a.bank_name} •••• ${a.account_number_last4}${a.label ? ` — ${a.label}` : ''}`,
                  }))}
                />
              );
            })}
          </div>
        )}

        {withdrawalsError && (
          <p className="mt-2 text-sm text-red-400">
            Could not load withdrawal history: {withdrawalsError.message}
          </p>
        )}

        <table className="mt-4 w-full text-left text-sm text-[var(--foreground)]">
          <thead>
            <tr className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
              <th className="pb-2 pr-4 font-medium">Amount</th>
              <th className="pb-2 pr-4 font-medium">Destination</th>
              <th className="pb-2 pr-4 font-medium">Status</th>
              <th className="pb-2 pr-4 font-medium">Initiated by</th>
              <th className="pb-2 font-medium">Date</th>
            </tr>
          </thead>
          <tbody>
            {withdrawalRows.map((w) => {
              const bankAccount = bankAccountById.get(w.platform_bank_account_id);
              return (
                <tr key={w.id} className="border-b border-[var(--border)]/50">
                  <td className="py-2 pr-4">{formatKobo(w.amount_minor, w.currency)}</td>
                  <td className="py-2 pr-4 text-xs text-[var(--foreground)]/60">
                    {bankAccount
                      ? `${bankAccount.bank_name} •••• ${bankAccount.account_number_last4}`
                      : '—'}
                  </td>
                  <td className="py-2 pr-4">{w.status}</td>
                  <td className="py-2 pr-4 text-xs text-[var(--foreground)]/60">
                    {adminEmailById.get(w.initiated_by_admin_id) ?? w.initiated_by_admin_id}
                  </td>
                  <td className="py-2 text-[var(--foreground)]/60">
                    {new Date(w.created_at).toLocaleString()}
                  </td>
                </tr>
              );
            })}
            {withdrawalRows.length === 0 && !withdrawalsError && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-[var(--foreground)]/60">
                  No withdrawals yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
