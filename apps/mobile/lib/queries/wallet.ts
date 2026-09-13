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

/** Polls-via-Realtime a single topup's status, so BuyCreditModal can detect
 * the moment a transfer clears and show the congrats screen instead of
 * making the user back out to the wallet screen and check manually.
 * `topups` was added to the supabase_realtime publication specifically for
 * this (see the enable_realtime_topups migration); RLS already scopes the
 * row to its owner. */
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
