// Human-readable labels for ledger_entries.reason. The check constraint
// backing this column has been widened five times since the original
// schema (confirmed directly — grepped every migration that touches
// ledger_entries_reason_check rather than trusting the first migration's
// 12-value list, which is stale): 23 values exist today. The fallback
// formatter means a 24th reason added later renders as reasonable
// title-case text instead of breaking this page.
const LABELS: Record<string, string> = {
  topup_purchase: 'Top-up purchase',
  topup_platform_fee: 'Top-up platform fee',
  message_debit: 'Message sent',
  escrow_hold: 'Escrow hold',
  escrow_release_earning: 'Escrow released (earning)',
  escrow_release_platform_cut: 'Escrow released (platform cut)',
  escrow_refund_unanswered: 'Escrow refunded (unanswered)',
  earnings_conversion: 'Earnings converted to cash',
  withdrawal_platform_fee: 'Withdrawal platform fee',
  withdrawal_payout: 'Withdrawal payout',
  withdrawal_refund_failed: 'Withdrawal refunded (failed)',
  status_upload_debit: 'Status upload',
  manual_adjustment: 'Manual adjustment',
  credit_transfer_sent: 'Credit transfer sent',
  credit_transfer_received: 'Credit transfer received',
  credit_transfer_conversion: 'Credit transfer converted to cash',
  credit_transfer_platform_cut: 'Credit transfer platform cut',
  group_message_debit: 'Group message sent',
  group_message_owner_earning: 'Group message owner earning',
  group_message_platform_cut: 'Group message platform cut',
  platform_reserve_skim: 'Platform reserve skim',
  chargeback_debit: 'Chargeback debit',
  chargeback_fee_reversal: 'Chargeback fee reversal',
};

export function reasonLabel(reason: string): string {
  return LABELS[reason] ?? reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const ALL_REASONS = Object.keys(LABELS);
