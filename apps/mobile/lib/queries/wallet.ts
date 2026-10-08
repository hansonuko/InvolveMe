import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { useRealtimeTableChanges } from '@/lib/realtimeChannel';
import { supabase } from '@/lib/supabase';

export interface Wallet {
  id: string;
  kind: 'topup_credit' | 'earnings_pending' | 'withdrawable_cash';
  balance: number;
  /** Also the clock fn_run_auto_withdraw_sweep itself reads for "how long
   * has this sat unswept" — the withdrawal countdown ring's data source. */
  updated_at: string;
}

/** All three of the current user's wallets, kept live via Realtime
 * Broadcast — per docs/05-API-REALTIME-SPEC.md §3 and
 * docs/01-ARCHITECTURE.md §4 (topic `wallets:<user_id>`, authorized via
 * RLS on `realtime.messages` rather than a postgres_changes filter — see
 * 20261008120000_realtime_broadcast_migration.sql — driving the
 * balance-update motion spec in docs/04-DESIGN-SYSTEM.md — the motion
 * itself isn't implemented here, just the live data it would react to).
 * Balances are exactly what the server returns; nothing here computes or
 * adjusts them, per CLAUDE.md rule #1. */
export function useWallets(userId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['wallets', userId];

  const query = useQuery({
    queryKey,
    enabled: !!userId,
    queryFn: async (): Promise<Wallet[]> => {
      const { data, error } = await supabase
        .from('wallets')
        .select('id, kind, balance, updated_at')
        .eq('user_id', userId);

      if (error) throw error;
      return data ?? [];
    },
  });

  useRealtimeTableChanges(
    userId ? `wallets:${userId}` : undefined,
    { event: '*', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
    () => queryClient.invalidateQueries({ queryKey }),
  );

  return query;
}

export function walletBalance(wallets: Wallet[] | undefined, kind: Wallet['kind']): number {
  return wallets?.find((w) => w.kind === kind)?.balance ?? 0;
}

export interface LedgerEntry {
  id: string;
  amount: number;
  reason: string;
  /** Which of the user's three wallets this line landed on — decides both
   * the unit (credits vs. kobo) and the sign convention shown, since a
   * conversion leg (e.g. `earnings_conversion`) produces one row per
   * wallet it touches, not one merged row. */
  wallet_kind: Wallet['kind'];
  created_at: string;
}

/** User-facing labels for every `ledger_entries.reason` a user could ever
 * see on their *own* wallets (per docs/03-ECONOMY-LEDGER.md's ledger-reason
 * list). Reasons that only ever land on the platform's own wallet
 * (`escrow_release_platform_cut`, `topup_platform_fee`,
 * `credit_transfer_platform_cut`, `group_message_platform_cut`,
 * `withdrawal_platform_fee` — the last one declared but never actually
 * inserted, see the security-definer-functions migration's own comment)
 * are deliberately omitted: RLS already means a user's own query can never
 * return one, so there's nothing to label. `escrow_hold` is the same
 * story for a different reason — that ledger reason is declared but
 * deliberately never inserted (the `escrows` table is itself the record
 * of a hold; see that migration's "v1 simplification" comment) — kept out
 * of this map for the same reason. A reason not in this map falls back to
 * a humanized version of the raw value rather than rendering blank. */
const LEDGER_ENTRY_LABELS: Record<string, string> = {
  topup_purchase: 'Credit purchased',
  message_debit: 'Message sent',
  escrow_release_earning: 'Earned from a reply',
  escrow_refund_unanswered: 'Refunded — no reply',
  earnings_conversion: 'Converted to cash',
  withdrawal_payout: 'Withdrawal sent',
  withdrawal_refund_failed: 'Withdrawal reversed',
  status_upload_debit: 'Status posted',
  manual_adjustment: 'Adjustment',
  credit_transfer_sent: 'Sent credit',
  credit_transfer_received: 'Received credit',
  credit_transfer_conversion: 'Converted to cash',
  group_message_debit: 'Group message sent',
  group_message_owner_earning: 'Group earning',
};

export function ledgerEntryLabel(reason: string): string {
  return LEDGER_ENTRY_LABELS[reason] ?? reason.replace(/_/g, ' ');
}

/** The only ledger reasons `ledger_entries_chat_counterparty`
 * (20260917090000_ledger_entries_chat_counterparty_view.sql) actually
 * resolves a counterparty for — see that migration's own comment for why
 * the rest (topups, withdrawals, status posts, adjustments, reserve/
 * chargeback bookkeeping, group-message reasons) have no single
 * counterparty to group by. Exported so the wallet tab's "bought/sent
 * credit" tab can filter the existing flat `useLedgerEntries` result to
 * the complementary set, rather than this classification living
 * separately in the UI layer. */
const CHAT_COUNTERPARTY_REASONS = new Set([
  'message_debit',
  'escrow_release_earning',
  'escrow_refund_unanswered',
  'credit_transfer_sent',
  'credit_transfer_received',
  'credit_transfer_conversion',
]);

export function isWalletOnlyLedgerReason(reason: string): boolean {
  return !CHAT_COUNTERPARTY_REASONS.has(reason);
}

interface ChatCounterpartyUser {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface ChatTransactionEntry {
  ledger_entry_id: string;
  amount: number;
  reason: string;
  created_at: string;
  wallet_kind: Wallet['kind'];
}

export interface ChatTransactionGroup {
  counterparty: ChatCounterpartyUser;
  entries: ChatTransactionEntry[]; // newest first
  lastActivityAt: string;
}

/** The caller's own ledger activity that involves another person (1:1
 * chat earnings/debits, peer credit transfers), grouped by who it was
 * with — the "chat transactions" half of Batch D's history split. Scoped
 * by RLS through `ledger_entries_chat_counterparty`'s `security_invoker`
 * view exactly like `useLedgerEntries` already relies on
 * `ledger_entries_select_own`, not by an explicit filter here. */
export function useChatTransactionHistory(userId: string | undefined, limit = 200) {
  return useQuery({
    queryKey: ['chatTransactionHistory', userId],
    enabled: !!userId,
    queryFn: async (): Promise<ChatTransactionGroup[]> => {
      const { data: rows, error } = await supabase
        .from('ledger_entries_chat_counterparty')
        .select('ledger_entry_id, amount, reason, created_at, wallet_kind, counterparty_id')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      if (!rows?.length) return [];

      const counterpartyIds = [...new Set(rows.map((r) => r.counterparty_id as string))];
      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in('id', counterpartyIds);
      if (usersError) throw usersError;

      const usersById = new Map((users ?? []).map((u) => [u.id, u as ChatCounterpartyUser]));

      const grouped = new Map<string, ChatTransactionGroup>();
      for (const row of rows) {
        const counterpartyId = row.counterparty_id as string;
        const entry: ChatTransactionEntry = {
          ledger_entry_id: row.ledger_entry_id,
          amount: row.amount,
          reason: row.reason,
          created_at: row.created_at,
          wallet_kind: row.wallet_kind,
        };
        const existing = grouped.get(counterpartyId);
        if (existing) {
          existing.entries.push(entry);
        } else {
          grouped.set(counterpartyId, {
            counterparty: usersById.get(counterpartyId) ?? {
              id: counterpartyId,
              display_name: null,
              avatar_url: null,
            },
            entries: [entry],
            lastActivityAt: row.created_at,
          });
        }
      }
      return [...grouped.values()].sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
    },
  });
}

/** The current user's most recent ledger activity across all three
 * wallets, newest first — rendered straight from `ledger_entries` per
 * docs/04-DESIGN-SYSTEM.md §5's wallet-tab spec ("transaction history
 * ...rendered straight from ledger_entries, user-facing labels mapped
 * from reason"), not a separately-computed summary. No explicit
 * `.eq('user_id', ...)` filter — `ledger_entries` has no direct user_id
 * column (only `wallet_id`), and `ledger_entries_select_own`'s RLS policy
 * (a join through `wallets.user_id = auth.uid()`) is what actually scopes
 * this to the caller's own rows; `userId` here only gates/keys the query. */
export function useLedgerEntries(userId: string | undefined, limit = 50) {
  const queryClient = useQueryClient();
  const queryKey = ['ledgerEntries', userId];

  const query = useQuery({
    queryKey,
    enabled: !!userId,
    queryFn: async (): Promise<LedgerEntry[]> => {
      const { data, error } = await supabase
        .from('ledger_entries')
        .select('id, amount, reason, created_at, wallets(kind)')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        amount: row.amount,
        reason: row.reason,
        // Embedded one-to-one via the wallet_id FK — always exactly one row.
        wallet_kind: (row.wallets as unknown as { kind: Wallet['kind'] }).kind,
        created_at: row.created_at,
      }));
    },
  });

  // ledger_entries has no broadcast trigger of its own — every ledger entry
  // has a corresponding wallets.balance change, so this piggybacks on the
  // exact same `wallets:${userId}` topic useWallets subscribes to, rather
  // than a separate `ledger-entries-via-wallets:${userId}` one (that used
  // to exist purely to avoid sharing a postgres_changes publication
  // subscription across two consumers — moot under Broadcast, which has no
  // publication to share; collapsing this halves the broadcasts a wallet
  // change fires, see 20261008120000_realtime_broadcast_migration.sql).
  useRealtimeTableChanges(
    userId ? `wallets:${userId}` : undefined,
    { event: '*', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
    () => queryClient.invalidateQueries({ queryKey }),
  );

  return query;
}

export interface LinkedBankAccount {
  id: string;
  bank_name: string;
  account_name: string;
  name_match_verified: boolean;
  provider_account_id: string | null;
}

/** Whether the user has a bank account linked and provider-verified enough
 * to withdraw to. Bank-account *linking* (the flow that would create one
 * of these for real) isn't built yet — see docs/00-SESSION-HANDOFF.md — so
 * this only ever finds something for a user a test fixture was inserted
 * for directly. The wallet screen uses this to show an honest "not set up
 * yet" state instead of a withdraw form that can only ever fail. */
export function useLinkedBankAccount(userId: string | undefined) {
  return useQuery({
    queryKey: ['bank_accounts', userId],
    enabled: !!userId,
    queryFn: async (): Promise<LinkedBankAccount | null> => {
      const { data, error } = await supabase
        .from('bank_accounts')
        .select('id, bank_name, account_name, name_match_verified, provider_account_id')
        .eq('user_id', userId)
        .eq('name_match_verified', true)
        .not('provider_account_id', 'is', null)
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
  });
}

interface BuyCreditResponse {
  topup_id: string;
  amount_kobo_paid: number;
  platform_fee_kobo: number;
  credits_issued: number;
  provider: string;
  bank_transfer: {
    account_number: string;
    bank_name: string | null;
    account_name: string | null;
    expires_at: string | null;
  };
}

/** Wraps POST /functions/v1/buy-credit. Returns a real bank-transfer
 * virtual account to display — the client never sees, let alone computes,
 * a checkout URL or a credit amount before the server does. */
export function useBuyCredit() {
  return useMutation({
    mutationFn: (amountKobo: number) =>
      callEdgeFunction<BuyCreditResponse>('buy-credit', { amount_kobo: amountKobo }),
  });
}

/** Tracks a single topup's status so BuyCreditModal can detect the moment
 * a transfer clears and show the congrats screen instead of making the
 * user back out to the wallet screen and check manually.
 *
 * Two layers, added at different times for different reasons
 * (docs/00-SESSION-HANDOFF.md session 12): the Realtime subscription +
 * plain DB read below react the instant *something else* (the webhook, if
 * it ever actually fires, or the reconcile-topups cron) writes
 * `topups.status`. But neither of those can be trusted to be fast — the
 * cron only checks topups older than 5 minutes, every 10 minutes, and the
 * webhook has never once fired in this app's history (see
 * reconcile-topups' own header). A user actively staring at this screen
 * waiting for their credit was left watching nothing happen for up to ~15
 * minutes, which is exactly the "wait aimlessly" complaint that prompted
 * this: `checkActiveTopupStatus` below actively asks the server "has this
 * cleared yet?" (check-topup-status, the same Flutterwave ground-truth
 * check reconcile-topups uses, but on demand and with no age gate) every
 * few seconds while the modal is open and still pending — this is now the
 * real fast path; the cron is the backstop for a user who closes the
 * modal or backgrounds the app before this ever gets to run. */
async function checkActiveTopupStatus(topupId: string): Promise<string> {
  const { status } = await callEdgeFunction<{ status: string }>('check-topup-status', {
    topup_id: topupId,
  });
  return status;
}

export function useTopupStatus(topupId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['topups', topupId];

  const query = useQuery({
    queryKey,
    enabled: !!topupId,
    queryFn: async (): Promise<string> => {
      const { data, error } = await supabase
        .from('topups')
        .select('status')
        .eq('id', topupId)
        .single();
      if (error) throw error;
      return data.status;
    },
    // Realtime pushes the update; this is just a safety-net poll in case a
    // websocket event is ever missed, so it doesn't need to be fast.
    refetchInterval: 5000,
  });

  useRealtimeTableChanges(
    topupId ? `topups:${topupId}` : undefined,
    { event: 'UPDATE', schema: 'public', table: 'topups', filter: `id=eq.${topupId}` },
    () => queryClient.invalidateQueries({ queryKey }),
  );

  // The active fast-path poll — stops itself the moment the topup resolves
  // (no point spending Flutterwave API calls once there's nothing left to
  // check), and stops entirely if the screen showing it unmounts (modal
  // closed), matching the honest "this screen updates itself" promise
  // BuyCreditModal makes only while it's actually still on screen.
  useEffect(() => {
    if (!topupId || query.data !== 'pending') return;

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const status = await checkActiveTopupStatus(topupId);
        if (!cancelled) queryClient.setQueryData(queryKey, status);
      } catch {
        // Transient network/edge-function hiccup — the next tick (or the
        // Realtime/5s-poll layer above) will catch it. Not worth surfacing
        // mid-poll.
      }
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topupId, query.data]);

  return query;
}

interface WithdrawResponse {
  withdrawal_id: string;
  amount_kobo: number;
  status: string;
}

/** Wraps POST /functions/v1/withdraw. `amountKobo` omitted withdraws the
 * full withdrawable_cash balance, per the function's own contract. */
export function useWithdraw() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { bankAccountId: string; amountKobo?: number }) =>
      callEdgeFunction<WithdrawResponse>('withdraw', {
        bank_account_id: params.bankAccountId,
        amount_kobo: params.amountKobo,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });
}

export interface WithdrawalCountdown {
  effective_sweep_hours: number;
  force_sweep_below_minimum: boolean;
}

/** Wraps GET /functions/v1/get-withdrawal-countdown — the caller's own
 * auto-sweep timing, per Phase 6's withdrawal countdown ring. Trust tier
 * changes rarely (it's driven by account age and fraud-signal history, not
 * anything the user does mid-session), so a generous staleTime avoids
 * refetching this on every wallet-tab focus. */
export function useWithdrawalCountdown(userId: string | undefined) {
  return useQuery({
    queryKey: ['withdrawalCountdown', userId],
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      callEdgeFunction<WithdrawalCountdown>('get-withdrawal-countdown', undefined, 'GET'),
  });
}

/** Direct read of one or more `pricing_config` values — fully
 * authenticated-readable per its own RLS policy, so no Edge Function
 * round trip is needed for values like `withdrawal_min_kobo` the client
 * only needs to display, not enforce (enforcement stays server-side
 * regardless, per CLAUDE.md rule #1). */
export function usePricingConfig(keys: string[]) {
  const sortedKeys = [...keys].sort();
  return useQuery({
    queryKey: ['pricingConfig', ...sortedKeys],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .from('pricing_config')
        .select('key, value')
        .in('key', sortedKeys);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((r) => [r.key, Number(r.value)]));
    },
    staleTime: 10 * 60 * 1000,
  });
}

interface TransferCreditResponse {
  transfer_id: string;
  credits_sent: number;
  platform_cut_credits: number;
  credits_received: number;
}

/** Wraps POST /functions/v1/transfer-credit. Sender -> recipient chat
 * credit, convertible to cash on the recipient's side (see
 * supabase/functions/transfer-credit's header comment) — flagged in
 * docs/00-SESSION-HANDOFF.md as shipped ahead of the legal review
 * docs/07-COMPLIANCE-LEGAL.md §1 calls for on this exact pattern. */
export function useTransferCredit() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { recipientPhone: string; credits: number; note?: string }) =>
      callEdgeFunction<TransferCreditResponse>('transfer-credit', {
        recipient_phone: params.recipientPhone,
        credits: params.credits,
        note: params.note,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });
}
