-- Extends the item-1 schema with two things discovered while designing the
-- money-moving functions (item 3) — both are additive/forward-only, nothing
-- from the original migration is altered in place.
--
-- 1. Platform revenue is actually TWO different units, not one:
--    - the 2% top-up fee is skimmed in kobo (cash), before any credit
--      conversion happens
--    - the 20% earnings take is skimmed in credits, at escrow release
--    A single 'platform_revenue' wallet can't hold both without silently
--    mixing units. Splitting into 'platform_revenue_topup_fees' (kobo) and
--    'platform_revenue_earnings_cut' (credits) keeps every wallet
--    single-unit, which is what makes the "sum(ledger_entries) ==
--    wallet.balance" invariant meaningful per wallet.
--    ('platform_revenue' is dropped — nothing was ever seeded under it.)
--
-- 2. ledger_entries needs one more reason: 'withdrawal_refund_failed', for
--    reversing a debit if a withdrawal's provider transfer call fails after
--    the DB has already committed the debit (see fn_fail_withdrawal in the
--    functions migration) — a real gap otherwise: money would leave a
--    user's withdrawable_cash wallet with no compensating path back if the
--    provider call fails downstream of this database.

alter table public.wallets drop constraint wallets_platform_wallet_has_no_user;
alter table public.wallets drop constraint wallets_kind_check;

alter table public.wallets add constraint wallets_kind_check check (
  kind in ('topup_credit', 'earnings_pending', 'withdrawable_cash', 'platform_revenue_topup_fees', 'platform_revenue_earnings_cut')
);

alter table public.wallets add constraint wallets_platform_wallet_has_no_user check (
  (kind in ('platform_revenue_topup_fees', 'platform_revenue_earnings_cut') and user_id is null) or
  (kind not in ('platform_revenue_topup_fees', 'platform_revenue_earnings_cut') and user_id is not null)
);

insert into public.wallets (user_id, kind, balance)
values
  (null, 'platform_revenue_topup_fees', 0),
  (null, 'platform_revenue_earnings_cut', 0);

alter table public.ledger_entries drop constraint ledger_entries_reason_check;

alter table public.ledger_entries add constraint ledger_entries_reason_check check (reason in (
  'topup_purchase',
  'topup_platform_fee',
  'message_debit',
  'escrow_hold',
  'escrow_release_earning',
  'escrow_release_platform_cut',
  'escrow_refund_unanswered',
  'earnings_conversion',
  'withdrawal_platform_fee',
  'withdrawal_payout',
  'withdrawal_refund_failed',
  'status_upload_debit',
  'manual_adjustment'
));
