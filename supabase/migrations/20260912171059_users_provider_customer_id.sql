-- Adds a place to cache the payment provider's own customer id for a user,
-- so buy-credit doesn't create a duplicate Flutterwave Customer object on
-- every top-up. Needed now that packages/payments/flutterwave.ts's
-- initiateCollection is real: Flutterwave v4's /charges and /orders both
-- require a pre-created customer_id (see docs/00-SESSION-HANDOFF.md's
-- session-3 section for the full v4 research).
--
-- Named provider-agnostically (mirrors bank_accounts.provider_account_id's
-- existing style) rather than flutterwave_customer_id, consistent with the
-- project's single-active-provider design (PAYMENTS_ACTIVE_PROVIDER) — if a
-- second provider is ever active concurrently rather than as a full
-- switchover, this will need a provider column alongside it, but that's not
-- today's problem.
--
-- Nullable: most existing users have never bought credit, so this stays
-- unset until their first successful buy-credit call creates one.

alter table public.users add column provider_customer_id text;

comment on column public.users.provider_customer_id is
  'Cached customer id from the active payment provider (see PAYMENTS_ACTIVE_PROVIDER), created on first buy-credit call. Not a secret, just avoids re-creating a provider Customer object on every top-up.';
