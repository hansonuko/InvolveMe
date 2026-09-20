-- Admin dashboard Phase B piece 1 (docs/14-ADMIN-DASHBOARD-SCOPING.md §8) —
-- real indexed search for the admin Users list. pg_trgm is already enabled
-- (20260915120000_rate_limit_duplicate_content.sql, for fraud duplicate-
-- content detection) but nothing in this codebase has used it to index
-- `users` yet — confirmed directly, no trigram/search index exists on this
-- table before this migration. Without these, an admin `ILIKE '%term%'`
-- search would be a full sequential scan, exactly the "load everything and
-- filter" anti-pattern docs/14 §8 explicitly rules out.
create index users_phone_trgm_idx on public.users using gin (phone gin_trgm_ops);
create index users_display_name_trgm_idx on public.users using gin (display_name gin_trgm_ops);
