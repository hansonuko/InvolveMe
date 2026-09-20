import { formatKobo } from '@/lib/money';

// Rough grouping for the pricing config editor (docs/14-ADMIN-DASHBOARD-SCOPING.md
// §4.2) — purely a display concern, derived from the real 31 keys read
// directly off the live dev pricing_config table, not from the doc's
// example list (which named a subset). Any key not listed here still
// renders, under "Uncategorized", rather than silently disappearing —
// this list is a display convenience, never a filter.
export type PricingCategory = {
  label: string;
  keys: string[];
};

export const PRICING_CATEGORIES: PricingCategory[] = [
  {
    label: 'Message & status pricing',
    keys: [
      'message_base_credits',
      'message_word_block_size',
      'message_max_words',
      'message_edit_window_minutes',
      'message_delete_window_minutes',
      'status_upload_credits_text',
      'status_upload_credits_media',
    ],
  },
  {
    label: 'Platform take rates & fees',
    keys: [
      'platform_earning_take_bps',
      'platform_topup_fee_bps',
      'platform_transfer_take_bps',
      'platform_group_message_take_bps',
      'platform_reserve_bps',
    ],
  },
  {
    label: 'Credits & transfers',
    keys: ['credit_unit_kobo', 'credit_transfer_max_credits'],
  },
  {
    label: 'Withdrawals',
    keys: [
      'withdrawal_auto_sweep_hours',
      'withdrawal_auto_sweep_hours_untrusted',
      'withdrawal_force_sweep_days',
      'withdrawal_min_kobo',
      'withdrawal_trust_signal_lookback_days',
      'kyc_tier1_daily_withdrawal_cap_kobo',
    ],
  },
  {
    label: 'Account & velocity limits',
    keys: ['new_account_age_days', 'new_account_daily_topup_cap_kobo'],
  },
  {
    label: 'Fraud & abuse detection',
    keys: [
      'collusion_concentration_min_messages',
      'collusion_concentration_share_bps',
      'collusion_shared_fingerprint_min_messages',
      'duplicate_content_lookback_messages',
      'duplicate_content_similarity_threshold_bps',
      'escrow_release_earnings_per_hour_cap',
      'escrow_release_messages_per_minute_cap',
      'escrow_unanswered_refund_hours',
    ],
  },
  {
    label: 'Feature flags',
    keys: ['group_chat_enabled'],
  },
];

const UNCATEGORIZED_LABEL = 'Uncategorized';

export function categoryForKey(key: string): string {
  return PRICING_CATEGORIES.find((c) => c.keys.includes(key))?.label ?? UNCATEGORIZED_LABEL;
}

export const PRICING_CATEGORY_ORDER = [
  ...PRICING_CATEGORIES.map((c) => c.label),
  UNCATEGORIZED_LABEL,
];

// Pure display hint, computed from the key's own naming convention (every
// _bps/_kobo key in this codebase means what its suffix says, per
// docs/03-ECONOMY-LEDGER.md) — never fed back into the edit form or the
// write path itself, which always submits/stores the same raw integer
// pricing_config.value already holds (CLAUDE.md rule #1: no financial
// arithmetic trusted from the client, and rule #2: money stays integers).
export function pricingValueHint(key: string, value: number, currency: string): string | null {
  if (key.endsWith('_bps')) {
    return `${(value / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }
  if (key.endsWith('_kobo')) {
    return formatKobo(value, currency);
  }
  if (key === 'group_chat_enabled') {
    return value === 1 ? 'Enabled' : 'Disabled';
  }
  return null;
}
