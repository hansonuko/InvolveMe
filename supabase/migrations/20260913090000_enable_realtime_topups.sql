-- The mobile buy-credit flow shows a virtual account number and needs to
-- know the moment the matching topup clears (see BuyCreditModal), rather
-- than the user having to back out and re-check the wallet manually.
-- `wallets` was already added to supabase_realtime (see the messages+
-- wallets migration); `topups` itself wasn't, so a client subscribing to
-- `postgres_changes` on topups (RLS already scopes this to the caller's
-- own rows, per docs/02-DATA-MODEL.md §2) would silently receive nothing.

alter publication supabase_realtime add table public.topups;
