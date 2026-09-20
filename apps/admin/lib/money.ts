// Matches apps/mobile's own convention exactly (BuyCreditModal.tsx:
// `₦${(kobo / 100).toLocaleString()}`) — topup_credit/earnings_pending
// wallets are credit-denominated (docs/02-DATA-MODEL.md: credit_unit_kobo
// = 1000, i.e. 1 credit = ₦10.00), every other wallet kind is kobo.
const CREDIT_DENOMINATED_KINDS = new Set(['topup_credit', 'earnings_pending']);

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
};
