import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getCurrentAdmin, checkPermission } from '@/lib/auth';
import { db } from '@/lib/supabase-admin';
import { encodeCursor, decodeCursor, cursorFilter } from '@/lib/pagination';
import { formatWalletAmount, formatKobo, WALLET_KIND_LABELS } from '@/lib/money';
import { pricingValueHint } from '@/lib/pricingCategories';
import { ApproveForm, RejectForm, ApplyForm } from './actions-forms';

const PAGE_SIZE = 25;

type PendingAction = {
  id: string;
  action_type: string;
  payload: Record<string, unknown>;
  requested_by: string;
  requested_at: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  executed_at: string | null;
  status: string;
};

const ACTION_TYPE_LABELS: Record<string, string> = {
  pricing_config_update: 'Pricing config change',
  manual_ledger_adjustment: 'Manual ledger adjustment',
  platform_bank_account_registration: 'Platform bank account registration',
  platform_withdrawal: 'Platform treasury withdrawal',
  message_pricing_strategy_change: 'Message pricing strategy change',
};

const MESSAGE_PRICING_STRATEGY_LABELS: Record<string, string> = {
  tiered_word_block: 'Tiered word block (the current default)',
  flat_per_message: 'Flat per message',
  linear_per_word: 'Linear per word',
};

export default async function PendingActionsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; status?: string; action_type?: string }>;
}) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect('/login');

  // The one permission every role that can propose anything (finance_admin,
  // super_admin — docs/14 §4.1) also holds, per the seed in
  // 20260920110000_admin_rbac_schema.sql — matches who this dual-approval
  // workflow is actually for.
  const allowed = await checkPermission(admin.id, 'approve_pending_action');
  if (!allowed) redirect('/dashboard');

  const params = await searchParams;
  const cursor = decodeCursor(params.cursor);
  const status = params.status ?? 'pending';

  let query = db()
    .from('admin_pending_actions')
    .select(
      'id, action_type, payload, requested_by, requested_at, approved_by, approved_at, rejected_by, rejected_at, rejection_reason, executed_at, status',
    )
    .order('requested_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (status !== 'all') query = query.eq('status', status);
  if (params.action_type) query = query.eq('action_type', params.action_type);
  if (cursor) query = query.or(cursorFilter(cursor, 'requested_at'));

  const { data, error } = await query;
  const rows = (data ?? []) as PendingAction[];
  const hasNextPage = rows.length > PAGE_SIZE;
  const pageRows = hasNextPage ? rows.slice(0, PAGE_SIZE) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  const nextCursor =
    hasNextPage && lastRow
      ? encodeCursor({ createdAt: lastRow.requested_at, id: lastRow.id })
      : null;

  const adminIds = Array.from(
    new Set(
      pageRows
        .flatMap((r) => [r.requested_by, r.approved_by, r.rejected_by])
        .filter((v): v is string => !!v),
    ),
  );
  const { data: admins } = adminIds.length
    ? await db().from('admin_users').select('id, email').in('id', adminIds)
    : { data: [] as { id: string; email: string }[] };
  const adminEmailById = new Map((admins ?? []).map((a) => [a.id, a.email]));

  const walletIds = Array.from(
    new Set(
      pageRows
        .filter((r) => r.action_type === 'manual_ledger_adjustment')
        .map((r) => r.payload.wallet_id as string)
        .filter(Boolean),
    ),
  );
  const { data: wallets } = walletIds.length
    ? await db().from('wallets').select('id, kind, user_id, currency').in('id', walletIds)
    : { data: [] as { id: string; kind: string; user_id: string | null; currency: string }[] };
  const walletById = new Map((wallets ?? []).map((w) => [w.id, w]));

  const walletUserIds = Array.from(
    new Set((wallets ?? []).map((w) => w.user_id).filter((v): v is string => !!v)),
  );
  const { data: walletUsers } = walletUserIds.length
    ? await db().from('users').select('id, display_name, phone').in('id', walletUserIds)
    : { data: [] as { id: string; display_name: string | null; phone: string | null }[] };
  const walletUserById = new Map((walletUsers ?? []).map((u) => [u.id, u]));

  const bankAccountIds = Array.from(
    new Set(
      pageRows
        .filter((r) => r.action_type === 'platform_withdrawal')
        .map((r) => r.payload.platform_bank_account_id as string)
        .filter(Boolean),
    ),
  );
  const { data: bankAccountsForWithdrawals } = bankAccountIds.length
    ? await db()
        .from('platform_bank_accounts')
        .select('id, bank_name, account_number_last4')
        .in('id', bankAccountIds)
    : { data: [] as { id: string; bank_name: string; account_number_last4: string }[] };
  const bankAccountByIdForWithdrawals = new Map(
    (bankAccountsForWithdrawals ?? []).map((b) => [b.id, b]),
  );

  function adminLabel(id: string | null): string {
    if (!id) return '—';
    return adminEmailById.get(id) ?? id;
  }

  function describePayload(row: PendingAction): string {
    if (row.action_type === 'pricing_config_update') {
      const key = String(row.payload.key ?? '');
      const currency = String(row.payload.currency ?? '');
      const newValue = Number(row.payload.new_value);
      const hint = pricingValueHint(key, newValue, currency);
      return `${key} (${currency}) → ${newValue}${hint ? ` (${hint})` : ''}`;
    }
    if (row.action_type === 'manual_ledger_adjustment') {
      const wallet = walletById.get(row.payload.wallet_id as string);
      const amount = Number(row.payload.amount);
      const amountLabel = wallet
        ? formatWalletAmount(amount, wallet.kind, wallet.currency)
        : String(amount);
      const walletLabel = wallet
        ? (WALLET_KIND_LABELS[wallet.kind] ?? wallet.kind)
        : 'unknown wallet';
      const userLabel = wallet?.user_id
        ? (walletUserById.get(wallet.user_id)?.display_name ??
          walletUserById.get(wallet.user_id)?.phone ??
          wallet.user_id)
        : null;
      const signed = amount > 0 ? `+${amountLabel}` : amountLabel;
      return `${userLabel ? `${userLabel} — ` : ''}${walletLabel}: ${signed}${
        row.payload.note ? ` — "${row.payload.note}"` : ''
      }`;
    }
    if (row.action_type === 'platform_bank_account_registration') {
      return `${row.payload.bank_name} •••• ${row.payload.account_number_last4} (${row.payload.currency}) — ${row.payload.account_name}${
        row.payload.label ? ` — ${row.payload.label}` : ''
      }`;
    }
    if (row.action_type === 'platform_withdrawal') {
      const bankAccount = bankAccountByIdForWithdrawals.get(
        row.payload.platform_bank_account_id as string,
      );
      const destination = bankAccount
        ? `${bankAccount.bank_name} •••• ${bankAccount.account_number_last4}`
        : 'unknown account';
      return `${formatKobo(Number(row.payload.amount_minor), String(row.payload.currency))} → ${destination}`;
    }
    if (row.action_type === 'message_pricing_strategy_change') {
      const strategy = String(row.payload.active_strategy ?? '');
      return `${row.payload.currency}: switch to ${MESSAGE_PRICING_STRATEGY_LABELS[strategy] ?? strategy}`;
    }
    return JSON.stringify(row.payload);
  }

  const baseParams = {
    ...(params.action_type ? { action_type: params.action_type } : {}),
    status,
  };

  return (
    <main className="p-8">
      <h1 className="text-lg font-semibold text-[var(--foreground)]">Pending actions</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--foreground)]/60">
        Materially risky changes (pricing take-rates, manual ledger adjustments) are proposed here,
        not applied directly — a different admin has to approve before either admin can apply it.
        Proposals expire after 72 hours if nobody decides.
      </p>

      <form method="get" className="mt-4 flex flex-wrap items-center gap-2">
        <select
          name="status"
          defaultValue={status}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved (not yet applied)</option>
          <option value="rejected">Rejected</option>
          <option value="expired">Expired</option>
          <option value="all">All</option>
        </select>
        <select
          name="action_type"
          defaultValue={params.action_type ?? ''}
          className="rounded border border-[var(--border)] bg-transparent px-2 py-1 text-xs text-[var(--foreground)]"
        >
          <option value="">All types</option>
          {Object.entries(ACTION_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
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

      {error && (
        <p className="mt-4 text-sm text-red-400">Could not load pending actions: {error.message}</p>
      )}

      <div className="mt-6 space-y-3">
        {pageRows.map((row) => {
          const isRequester = row.requested_by === admin.id;
          return (
            <div
              key={row.id}
              className="rounded border border-[var(--border)] bg-[var(--surface)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-[var(--foreground)]">
                    {ACTION_TYPE_LABELS[row.action_type] ?? row.action_type}
                  </p>
                  <p className="mt-1 text-sm text-[var(--foreground)]/80">{describePayload(row)}</p>
                  <p className="mt-2 text-xs text-[var(--foreground)]/60">
                    Requested by {adminLabel(row.requested_by)}
                    {isRequester && ' (you)'} — {new Date(row.requested_at).toLocaleString()}
                  </p>
                  {row.status === 'approved' && (
                    <p className="mt-1 text-xs text-[var(--foreground)]/60">
                      Approved by {adminLabel(row.approved_by)} —{' '}
                      {row.approved_at && new Date(row.approved_at).toLocaleString()}
                      {row.executed_at &&
                        ` · Applied ${new Date(row.executed_at).toLocaleString()}`}
                    </p>
                  )}
                  {row.status === 'rejected' && (
                    <p className="mt-1 text-xs text-[var(--foreground)]/60">
                      Rejected by {adminLabel(row.rejected_by)} —{' '}
                      {row.rejected_at && new Date(row.rejected_at).toLocaleString()}
                      {row.rejection_reason && `: "${row.rejection_reason}"`}
                    </p>
                  )}
                  {row.status === 'expired' && (
                    <p className="mt-1 text-xs text-[var(--foreground)]/60">
                      Expired 72 hours after being requested — nobody decided in time.
                    </p>
                  )}
                </div>

                <div className="flex flex-col items-end gap-2">
                  {row.status === 'pending' && !isRequester && (
                    <div className="flex gap-2">
                      <ApproveForm pendingActionId={row.id} />
                      <RejectForm pendingActionId={row.id} />
                    </div>
                  )}
                  {row.status === 'pending' && isRequester && (
                    <RejectForm pendingActionId={row.id} label="Cancel" />
                  )}
                  {row.status === 'approved' && !row.executed_at && (
                    <ApplyForm
                      pendingActionId={row.id}
                      actionType={row.action_type}
                      payload={row.payload}
                    />
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {pageRows.length === 0 && !error && (
          <p className="py-6 text-center text-sm text-[var(--foreground)]/60">
            No pending actions match.
          </p>
        )}
      </div>

      {nextCursor && (
        <Link
          href={`/dashboard/pending-actions?${new URLSearchParams({ ...baseParams, cursor: nextCursor }).toString()}`}
          className="mt-6 inline-block rounded bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
