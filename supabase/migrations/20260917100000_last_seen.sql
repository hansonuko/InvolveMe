-- Online/last-seen indicator (docs/10-UX-REFINEMENT-BACKLOG.md Batch B,
-- B2's genuinely-new half — split into its own migration/PR from the rest
-- of Batch B, which shipped without it).
--
-- Deliberately NOT a Realtime Presence channel, despite that being this
-- app's own docs/05-API-REALTIME-SPEC.md §3 original spec for "online
-- status" — Presence adds a second, more complex Realtime primitive
-- (join/leave lifecycle, reconnection semantics) for what only needs to
-- be coarse ("online" vs "last seen around HH:MM") anyway. Reusing the
-- exact pattern already established everywhere else in this app instead:
-- a plain timestamp column, updated by the client on a heartbeat, kept
-- live via a `postgres_changes` subscription on `users` — same shape as
-- `useThreadMessages`/`useWallets`. "Online now" is derived purely
-- client-side (last_seen_at within the last ~45s, comfortably longer than
-- the ~30s heartbeat interval so one missed tick doesn't flip someone to
-- "offline" spuriously) — no separate `is_online` boolean to keep in sync.
--
-- Same client-writable-column posture `read_receipts_enabled`
-- (20260914090000_settings_privacy_reports_push.sql) already established:
-- self-scoped via `users_update_own`'s existing RLS, no fraud value in a
-- user misrepresenting their own last-seen timestamp or its visibility
-- toggle, so a plain grant is enough — no SECURITY DEFINER function
-- needed for either column.

alter table public.users
  add column last_seen_at timestamptz,
  add column last_seen_enabled boolean not null default true;

grant update (last_seen_at, last_seen_enabled) on public.users to authenticated;
