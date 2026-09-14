import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

export interface Wallet {
  id: string;
  kind: 'topup_credit' | 'earnings_pending' | 'withdrawable_cash';
  balance: number;
}

/** All three of the current user's wallets, kept live via Realtime — per
 * docs/05-API-REALTIME-SPEC.md §3 (`postgres_changes` on `wallets` filtered
 * by `user_id`, driving the balance-update motion spec in
 * docs/04-DESIGN-SYSTEM.md — the motion itself isn't implemented here,
 * just the live data it would react to). Balances are exactly what the
 * server returns; nothing here computes or adjusts them, per CLAUDE.md
 * rule #1. */
export function useWallets(userId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['wallets', userId];

  const query = useQuery({
    queryKey,
    enabled: !!userId,
    queryFn: async (): Promise<Wallet[]> => {
      const { data, error } = await supabase
        .from('wallets')
        .select('id, kind, balance')
        .eq('user_id', userId);

      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`wallets:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
        () => queryClient.invalidateQueries({ queryKey }),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

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

  // ledger_entries itself isn't on the supabase_realtime publication (only
  // messages/wallets/topups are) — every ledger entry has a corresponding
  // wallets.balance change, so piggybacking on useWallets' own realtime
  // channel (same table/filter) keeps this live without adding a second
  // table to the publication for one more subscriber.
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`ledger-entries-via-wallets:${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
        () => queryClient.invalidateQueries({ queryKey }),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

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

  useEffect(() => {
    if (!topupId) return;

    const channel = supabase
      .channel(`topups:${topupId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'topups', filter: `id=eq.${topupId}` },
        () => queryClient.invalidateQueries({ queryKey }),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topupId]);

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
