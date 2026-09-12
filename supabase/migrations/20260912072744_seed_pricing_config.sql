-- v1 pricing defaults from docs/03-ECONOMY-LEDGER.md. Every function in the
-- next migration reads these at call time rather than hardcoding numbers —
-- see CLAUDE.md rule #9. Change values here (or via an ops tool later),
-- never in application code.

insert into public.pricing_config (key, value, description) values
  ('credit_unit_kobo', 1000, '1 credit = this many kobo (₦10.00)'),
  ('message_base_credits', 2, 'Credits per word-block for a message'),
  ('message_word_block_size', 50, 'Words per block for message billing'),
  ('message_max_words', 500, 'Hard cap on words per message (server-enforced)'),
  ('status_upload_credits_text', 3, 'Credits to post a text-only status'),
  ('status_upload_credits_media', 6, 'Credits to post a media status'),
  ('platform_topup_fee_bps', 200, 'Platform fee on every credit top-up, in basis points (200 = 2.00%)'),
  ('platform_earning_take_bps', 2000, 'Platform cut on every escrow release, in basis points (2000 = 20.00%)'),
  ('withdrawal_min_kobo', 50000, 'Minimum payout batch (₦500) before the auto-sweep''s 7-day override'),
  ('withdrawal_auto_sweep_hours', 24, 'Hours after which unwithdrawn earnings auto-sweep to bank'),
  ('escrow_unanswered_refund_hours', 48, 'Hours after which an unanswered message''s escrow auto-refunds to the payer'),
  ('kyc_tier1_daily_withdrawal_cap_kobo', 5000000, 'Daily withdrawal cap for KYC Tier 1 users (₦50,000); Tier 2+ uncapped in v1');
