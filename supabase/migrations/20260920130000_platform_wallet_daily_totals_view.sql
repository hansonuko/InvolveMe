-- Admin dashboard Phase B piece 3 (docs/14-ADMIN-DASHBOARD-SCOPING.md §5/§8) —
-- server-side daily aggregation for the Treasury view, so the admin
-- backend never fetches raw ledger_entries and sums them in Node/the
-- browser (docs/14 §8's explicit instruction).
--
-- `security_invoker = true` is load-bearing, same reason
-- 20260917090000_ledger_entries_chat_counterparty_view.sql already
-- documents: without it, this view would run with the CREATING role's RLS
-- context (effectively bypassing RLS for anyone with SELECT on the view),
-- not the querying role's — wallets/ledger_entries are both RLS-enabled
-- with zero policies, so with security_invoker this view is correctly
-- invisible to anon/authenticated by construction, and only ever
-- meaningfully queried by service_role (which bypasses RLS entirely,
-- same as every other admin-backend read). No `grant ... to authenticated`
-- here, unlike that other view — this one is treasury-internal only.
create view public.platform_wallet_daily_totals
with (security_invoker = true)
as
select
  w.id as wallet_id,
  w.kind,
  w.currency,
  date_trunc('day', le.created_at) as day,
  sum(le.amount) as net_amount
from public.wallets w
join public.ledger_entries le on le.wallet_id = w.id
where w.user_id is null
group by w.id, w.kind, w.currency, date_trunc('day', le.created_at);

-- Defense-in-depth, matching the explicit-revoke posture
-- 20260920111500_admin_rbac_functions.sql already established for
-- admin_audit_log — RLS-zero-policies should already block anon/
-- authenticated given security_invoker above, but an explicit revoke
-- costs nothing and this project has already been burned once by an
-- assumption about what a bare RLS/grant setup actually blocks.
revoke select on public.platform_wallet_daily_totals from anon, authenticated, public;
grant select on public.platform_wallet_daily_totals to service_role;
