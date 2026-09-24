-- Admin dashboard Phase G piece 1 (docs/14-ADMIN-DASHBOARD-SCOPING.md §8) —
-- server-side aggregation for the Location Stats page, so the admin
-- backend never fetches every user row and counts in Node/the browser
-- (§8's explicit "never fetch all rows, sum in the browser" instruction,
-- same reasoning 20260920130000_platform_wallet_daily_totals_view.sql
-- already applied to Treasury).
--
-- `security_invoker = true` is load-bearing, same reason that view's own
-- header documents: without it, this view would run with the CREATING
-- role's RLS context, not the querying role's. `users` is RLS-enabled
-- (20260912070729_create_core_schema.sql), so with security_invoker this
-- view is correctly invisible to anon/authenticated by construction, and
-- only ever meaningfully queried by service_role (which bypasses RLS
-- entirely, same as every other admin-backend read).
--
-- No index added on users.country for this: it's a low-cardinality column
-- (a small fixed set of countries plus NULL), so a btree index wouldn't
-- meaningfully cheapen a full-table `count(*) group by` the planner would
-- still resolve with a seq scan + hash aggregate regardless — this is the
-- traffic-scale-appropriate plan for this shape of aggregate, not a case
-- that call for indexing.
create view public.users_country_stats
with (security_invoker = true)
as
select
  coalesce(country, 'UNKNOWN') as country,
  count(*) as user_count
from public.users
group by coalesce(country, 'UNKNOWN');

-- Defense-in-depth, matching the explicit-revoke posture this project
-- already committed to after the CLAUDE.md rule #11 incident — RLS should
-- already block anon/authenticated given security_invoker above, but an
-- explicit revoke costs nothing.
revoke select on public.users_country_stats from anon, authenticated, public;
grant select on public.users_country_stats to service_role;
