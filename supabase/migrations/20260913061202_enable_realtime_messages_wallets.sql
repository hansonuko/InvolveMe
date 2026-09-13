-- Found while wiring up the mobile chat/wallet UI to Realtime (per
-- docs/05-API-REALTIME-SPEC.md §3): no migration had ever added any table
-- to the `supabase_realtime` publication, confirmed by querying
-- pg_publication_tables directly and getting zero rows. The mobile app's
-- `postgres_changes` subscriptions on `messages` and `wallets` would have
-- connected successfully and just never received an event — the failure
-- mode of a missing publication membership is silence, not an error, which
-- is exactly the kind of thing that looks fine in a demo (the sender's own
-- optimistic refetch on send still works) and quietly breaks for the other
-- participant, who would never see a new message arrive without manually
-- leaving and re-entering the thread.
--
-- Safe from an access-control standpoint: Realtime enforces each table's
-- existing RLS policies for `postgres_changes` (a client only receives
-- change events for rows it could otherwise SELECT), and both tables
-- already have RLS enabled with exactly the policies this needs
-- (messages_select_participant, wallets_select_own) — enabling Realtime
-- here doesn't loosen access, it only starts pushing updates for access
-- that already existed.
--
-- Scoped to the two tables the app actually subscribes to today
-- (messages, wallets) rather than every table, per the same
-- least-privilege instinct as everything else in this schema.

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.wallets;
