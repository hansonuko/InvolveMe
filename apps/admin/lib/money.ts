// Matches apps/mobile's own convention exactly (BuyCreditModal.tsx:
// `₦${(kobo / 100).toLocaleString()}`) — topup_credit/earnings_pending
// wallets are credit-denominated (docs/02-DATA-MODEL.md: credit_unit_kobo
// = 1000, i.e. 1 credit = ₦10.00), every other wallet kind is kobo.
//
// platform_revenue_earnings_cut/platform_reserve_earnings_cut are ALSO
// credit-denominated — confirmed by reading every fn_credit_platform_revenue
// call site directly (20260915150000_platform_reserve_buffer.sql), not
// assumed from the name: the "earnings cut" is always a percentage of
// credits_held/p_credits taken before the escrow/transfer/group-message
// credit-to-cash conversion happens, so it's credited to these two wallets
// as raw credits with no corresponding cash-conversion entry anywhere.
// platform_revenue_topup_fees/platform_reserve_topup_fees are the only
// platform wallets actually denominated in kobo (v_topup.platform_fee_kobo
// is already cash). Getting this wrong would show a credits balance as if
// it were naira, off by exactly credit_unit_kobo (1000x) — the same class
// of bug already caught and avoided once for user wallets.
const CREDIT_DENOMINATED_KINDS = new Set([
  'topup_credit',
  'earnings_pending',
  'platform_revenue_earnings_cut',
  'platform_reserve_earnings_cut',
]);

export function formatKobo(kobo: number, currency = 'NGN'): string {
  const symbol = currency === 'NGN' ? '₦' : `${currency} `;
  return `${symbol}${(kobo / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatCredits(amount: number): string {
  return `${amount.toLocaleString()} credit${Math.abs(amount) === 1 ? '' : 's'}`;
}

export function formatWalletAmount(amount: number, walletKind: string, currency = 'NGN'): string {
  return CREDIT_DENOMINATED_KINDS.has(walletKind)
    ? formatCredits(amount)
    : formatKobo(amount, currency);
}

export const WALLET_KIND_LABELS: Record<string, string> = {
  topup_credit: 'Top-up Credit',
  earnings_pending: 'Earnings (Pending)',
  withdrawable_cash: 'Withdrawable Cash',
  platform_revenue_topup_fees: 'Revenue — Top-up Fees',
  platform_revenue_earnings_cut: 'Revenue — Earnings Cut',
  platform_reserve_topup_fees: 'Reserve — Top-up Fees',
  platform_reserve_earnings_cut: 'Reserve — Earnings Cut',
};
