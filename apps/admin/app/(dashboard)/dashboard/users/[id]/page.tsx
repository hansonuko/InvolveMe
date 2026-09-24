import Link from 'next/link';
import { redirect, notFound } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { encodeCursor, decodeCursor, cursorFilter } from '@/lib/pagination';
import { formatWalletAmount, formatKobo, WALLET_KIND_LABELS } from '@/lib/money';
import { reasonLabel, ALL_REASONS } from '@/lib/ledgerReasons';
import { setWalletFrozenAction } from '@/app/actions/fraud';
import { ProposeManualAdjustmentForm } from './actions-forms';

const LEDGER_PAGE_SIZE = 25;
// Per-user, inherently low-cardinality lists (docs/14 §8's "never offset
// paginate" concern is about large, frequently-changing tables — a single
// user's own KYC/withdrawal history isn't that) get a plain recency cap
// instead of full cursor machinery. Only ledger_entries, which a very
// active user could genuinely accumulate hundreds/thousands of, gets real
// cursor pagination below.
const RECENT_CAP = 20;

type Wallet = {
  id: string;
  kind: string;
  balance: number;
  is_frozen: boolean;
  currency: string;
  updated_at: string;
};

type LedgerEntry = {
  id: string;
  wallet_id: string;
  amount: number;
  reason: string;
  ref_type: string | null;
  ref_id: string | null;
  currency: string;
  created_at: string;
};

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ cursor?: string; reason?: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  const allowed = await checkPermission(admin.id, 'view_users');
  if (!allowed) redirect('/dashboard');

  const canFreezeWallets = await checkPermission(admin.id, 'resolve_fraud_signal');
  const canProposeAdjustment = await checkPermission(admin.id, 'post_manual_adjustment');

  const { id } = await params;
  const { cursor: cursorParam, reason: reasonFilter } = await searchParams;
  const cursor = decodeCursor(cursorParam);

  const { data: user, error: userError } = await db()
    .from('users')
    .select('id, phone, display_name, country, kyc_tier, is_suspended, created_at')
    .eq('id', id)
    .single();

  if (userError || !user) notFound();

  const [{ data: wallets }, { data: kycRecords }, { data: bankAccounts }, { data: withdrawals }] =
    await Promise.all([
      db()
        .from('wallets')
        .select('id, kind, balance, is_frozen, currency, updated_at')
        .eq('user_id', id)
        .order('kind'),
      db()
        .from('kyc_records')
        .select('id, tier, provider, status, verified_at, expires_at, created_at')
        .eq('user_id', id)
        .order('created_at', { ascending: false })
        .limit(RECENT_CAP),
      db()
        .from('bank_accounts')
        .select(
          'id, bank_name, account_number_last4, account_name, name_match_verified, created_at',
        )
        .eq('user_id', id)
        .order('created_at', { ascending: false }),
      db()
        .from('withdrawals')
        .select('id, amount_kobo, platform_fee_kobo, status, triggered_by, created_at')
        .eq('user_id', id)
        .order('created_at', { ascending: false })
        .limit(RECENT_CAP),
    ]);

  const walletRows = (wallets ?? []) as Wallet[];
  const walletKindById = new Map(walletRows.map((w) => [w.id, w.kind]));
  const walletIds = walletRows.map((w) => w.id);

  // Bounded fetch (pending/approved-unexecuted manual adjustments are
  // never numerous for one user) to show "already proposed" inline
  // instead of letting a second proposal get made against the same
  // wallet before the first is decided.
  const { data: pendingAdjustments } = canProposeAdjustment
    ? await db()
        .from('admin_pending_actions')
        .select('id, payload, status')
        .eq('action_type', 'manual_ledger_adjustment')
        .in('status', ['pending', 'approved'])
    : { data: [] as { id: string; payload: { wallet_id?: string }; status: string }[] };
  const pendingAdjustmentByWalletId = new Map(
    (pendingAdjustments ?? [])
      .filter((p) => walletIds.includes(p.payload?.wallet_id ?? ''))
      .map((p) => [p.payload.wallet_id as string, p]),
  );

  let ledgerRows: LedgerEntry[] = [];
  let ledgerError: string | null = null;
  let nextCursor: string | null = null;

  if (walletIds.length > 0) {
    let ledgerQuery = db()
      .from('ledger_entries')
      .select('id, wallet_id, amount, reason, ref_type, ref_id, currency, created_at')
      .in('wallet_id', walletIds)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(LEDGER_PAGE_SIZE + 1);

    if (reasonFilter) ledgerQuery = ledgerQuery.eq('reason', reasonFilter);
    if (cursor) ledgerQuery = ledgerQuery.or(cursorFilter(cursor));

    const { data, error } = await ledgerQuery;
    ledgerError = error?.message ?? null;
    const rows = (data ?? []) as LedgerEntry[];
    const hasNextPage = rows.length > LEDGER_PAGE_SIZE;
    ledgerRows = hasNextPage ? rows.slice(0, LEDGER_PAGE_SIZE) : rows;
    const lastRow = ledgerRows[ledgerRows.length - 1];
    nextCursor =
      hasNextPage && lastRow
        ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.id })
        : null;
  }

  return (
    <main className="p-8">
      <Link href="/dashboard/users" className="text-sm text-[var(--foreground)]/60 hover:underline">
        ← Users
      </Link>

      <h1 className="mt-2 text-lg font-semibold text-[var(--foreground)]">
        {user.display_name ?? user.phone ?? user.id}
      </h1>
      <p className="mt-1 text-sm text-[var(--foreground)]/60">
        {user.phone ?? '—'} · KYC tier {user.kyc_tier} · {user.country ?? 'Unknown country'} ·{' '}
        {user.is_suspended ? 'Suspended' : 'Active'} · joined{' '}
        {new Date(user.created_at).toLocaleDateString()}
      </p>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Wallets</h2>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {walletRows.map((w) => (
            <div
              key={w.id}
              className="rounded border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <p className="text-xs text-[var(--foreground)]/60">
                {WALLET_KIND_LABELS[w.kind] ?? w.kind}
              </p>
              <p className="mt-1 text-lg font-semibold text-[var(--foreground)]">
                {formatWalletAmount(w.balance, w.kind, w.currency)}
              </p>
              {w.is_frozen && (
                <p className="mt-1 text-xs font-medium text-[var(--danger)]">Frozen</p>
              )}
              {canFreezeWallets && (
                <form action={setWalletFrozenAction} className="mt-2">
                  <input type="hidden" name="wallet_id" value={w.id} />
                  <input type="hidden" name="user_id" value={id} />
                  <input type="hidden" name="frozen" value={(!w.is_frozen).toString()} />
                  <button
                    type="submit"
                    className="text-xs font-medium text-[var(--foreground)]/60 hover:text-[var(--foreground)]"
                  >
                    {w.is_frozen ? 'Unfreeze' : 'Freeze'}
                  </button>
                </form>
              )}
              {canProposeAdjustment &&
                (pendingAdjustmentByWalletId.has(w.id) ? (
                  <p className="mt-2 text-xs text-[var(--foreground)]/60">
                    {pendingAdjustmentByWalletId.get(w.id)!.status === 'approved'
                      ? 'Adjustment approved — ready to apply.'
                      : 'Adjustment proposed, awaiting approval.'}{' '}
                    <Link
                      href="/dashboard/pending-actions"
                      className="text-[var(--accent)] hover:underline"
                    >
                      View in queue →
                    </Link>
                  </p>
                ) : (
                  <ProposeManualAdjustmentForm walletId={w.id} walletKind={w.kind} />
                ))}
            </div>
          ))}
          {walletRows.length === 0 && (
            <p className="text-sm text-[var(--foreground)]/60">No wallets found.</p>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">KYC</h2>
        {(kycRecords ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--foreground)]/60">No KYC records.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--foreground)]">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
                  <th className="pb-2 pr-4 font-medium">Tier</th>
                  <th className="pb-2 pr-4 font-medium">Provider</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Verified</th>
                  <th className="pb-2 font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {(kycRecords ?? []).map((k) => (
                  <tr key={k.id} className="border-b border-[var(--border)]/50">
                    <td className="py-2 pr-4">{k.tier}</td>
                    <td className="py-2 pr-4">{k.provider ?? '—'}</td>
                    <td className="py-2 pr-4">{k.status}</td>
                    <td className="py-2 pr-4">
                      {k.verified_at ? new Date(k.verified_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="py-2">
                      {k.expires_at ? new Date(k.expires_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Bank accounts</h2>
        {(bankAccounts ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--foreground)]/60">No bank account linked.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--foreground)]">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
                  <th className="pb-2 pr-4 font-medium">Bank</th>
                  <th className="pb-2 pr-4 font-medium">Account</th>
                  <th className="pb-2 pr-4 font-medium">Name on account</th>
                  <th className="pb-2 font-medium">Name match verified</th>
                </tr>
              </thead>
              <tbody>
                {(bankAccounts ?? []).map((b) => (
                  <tr key={b.id} className="border-b border-[var(--border)]/50">
                    <td className="py-2 pr-4">{b.bank_name ?? '—'}</td>
                    <td className="py-2 pr-4">•••• {b.account_number_last4 ?? '????'}</td>
                    <td className="py-2 pr-4">{b.account_name ?? '—'}</td>
                    <td className="py-2">{b.name_match_verified ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold text-[var(--foreground)]">Withdrawals</h2>
        {(withdrawals ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-[var(--foreground)]/60">No withdrawals.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm text-[var(--foreground)]">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
                  <th className="pb-2 pr-4 font-medium">Amount</th>
                  <th className="pb-2 pr-4 font-medium">Fee</th>
                  <th className="pb-2 pr-4 font-medium">Status</th>
                  <th className="pb-2 pr-4 font-medium">Triggered by</th>
                  <th className="pb-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {(withdrawals ?? []).map((w) => (
                  <tr key={w.id} className="border-b border-[var(--border)]/50">
                    <td className="py-2 pr-4">{formatKobo(w.amount_kobo)}</td>
                    <td className="py-2 pr-4">{formatKobo(w.platform_fee_kobo)}</td>
                    <td className="py-2 pr-4">{w.status}</td>
                    <td className="py-2 pr-4">{w.triggered_by}</td>
                    <td className="py-2">{new Date(w.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-[var(--foreground)]">Transaction history</h2>
          <form method="get" className="flex items-center gap-2">
            <select
              name="reason"
              defaultValue={reasonFilter ?? ''}
              className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
            >
              <option value="">All reasons</option>
              {ALL_REASONS.map((r) => (
                <option key={r} value={r}>
                  {reasonLabel(r)}
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
        </div>

        {ledgerError && (
          <p className="mt-2 text-sm text-[var(--danger)]">
            Could not load transactions: {ledgerError}
          </p>
        )}

        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm text-[var(--foreground)]">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-[var(--foreground)]/60">
                <th className="pb-2 pr-4 font-medium">Reason</th>
                <th className="pb-2 pr-4 font-medium">Wallet</th>
                <th className="pb-2 pr-4 font-medium">Amount</th>
                <th className="pb-2 pr-4 font-medium">Reference</th>
                <th className="pb-2 font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {ledgerRows.map((entry) => {
                const kind = walletKindById.get(entry.wallet_id) ?? '';
                return (
                  <tr key={entry.id} className="border-b border-[var(--border)]/50">
                    <td className="py-2 pr-4">{reasonLabel(entry.reason)}</td>
                    <td className="py-2 pr-4">{WALLET_KIND_LABELS[kind] ?? kind}</td>
                    <td className="py-2 pr-4">
                      {formatWalletAmount(entry.amount, kind, entry.currency)}
                    </td>
                    <td className="py-2 pr-4 text-xs text-[var(--foreground)]/60">
                      {entry.ref_type ? `${entry.ref_type}` : '—'}
                    </td>
                    <td className="py-2 text-[var(--foreground)]/60">
                      {new Date(entry.created_at).toLocaleString()}
                    </td>
                  </tr>
                );
              })}
              {ledgerRows.length === 0 && !ledgerError && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-[var(--foreground)]/60">
                    No transactions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {nextCursor && (
          <Link
            href={`/dashboard/users/${id}?${new URLSearchParams({
              ...(reasonFilter ? { reason: reasonFilter } : {}),
              cursor: nextCursor,
            }).toString()}`}
            className="mt-4 inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--on-accent)]"
          >
            Next page
          </Link>
        )}
      </section>
    </main>
  );
}
