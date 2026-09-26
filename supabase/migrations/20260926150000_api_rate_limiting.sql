-- API-level rate limiting (docs/19-SECURITY-HARDENING-SCOPING.md §3) — a
-- real gap distinct from every rate limit this app already had: §6 of
-- docs/06-SECURITY-FRAUD-LOOPHOLES.md's message-per-minute/duplicate-content
-- checks (fn_release_escrow) govern whether an escrow releases as earnings,
-- not whether a request is accepted at all. Nothing today stops a script
-- from hammering a cheap, credit-free endpoint (OTP send, phone lookup) at
-- high volume — Supabase's own platform-level limits are the only backstop,
-- and those are generic, not tuned to this app's actual abuse shapes
-- (phone-number enumeration, OTP-bombing).
--
-- Postgres-native, not Redis (CLAUDE.md rule #10, "stay lite" — this app has
-- never operated a Redis instance and every other velocity/rate control it
-- has is already plain Postgres; introducing a new stateful service for
-- this one control would be new infrastructure to run and pay for, not a
-- library import). Fixed-window counter, not token-bucket/leaky-bucket:
-- simpler to reason about and implement as one atomic upsert, and the
-- precision difference (a fixed window allows a short burst right at a
-- window boundary) doesn't matter for what this is actually defending
-- against — an attacker running thousands of calls, not one running exactly
-- at the boundary.

create table public.rate_limit_buckets (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- Every check touches "this key, this window" — the primary key already
-- covers that access path. A separate index on window_start alone is for
-- the cleanup job below, which deletes by age across all keys at once.
create index rate_limit_buckets_window_start_idx on public.rate_limit_buckets (window_start);

alter table public.rate_limit_buckets enable row level security;
-- No policy at all: this table has no legitimate client-readable content
-- (a caller learning another key's current count is not useful, and
-- learning their own is not something the UI needs) — service_role, which
-- bypasses RLS entirely, is the only reader/writer, via the function below.

-- =============================================================================
-- fn_check_rate_limit — atomic increment-and-check. `p_key` is the caller's
-- own construction (e.g. `web-send-otp:phone:<number>` or
-- `find-user-by-phone:user:<uuid>`) — this function has no opinion on what a
-- key means, only on counting calls to it within a window. Returns true if
-- the call should be ALLOWED (count is still within p_max_count), false if
-- it should be rejected. The insert-on-conflict is a single atomic
-- statement — two concurrent calls for the same key/window can't race past
-- each other and both read a stale pre-increment count the way a separate
-- select-then-update would.
-- =============================================================================

create function public.fn_check_rate_limit(p_key text, p_max_count integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count integer;
begin
  v_window_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into rate_limit_buckets (key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (key, window_start) do update set count = rate_limit_buckets.count + 1
  returning count into v_count;

  return v_count <= p_max_count;
end;
$$;

revoke execute on function public.fn_check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.fn_check_rate_limit(text, integer, integer) to service_role;

-- =============================================================================
-- fn_cleanup_rate_limit_buckets — a fixed-window counter table grows
-- forever without this; every window this app will ever configure is
-- measured in minutes/hours, so anything older than a day is unambiguously
-- done being read by fn_check_rate_limit and safe to drop. Same "plain
-- plpgsql function on a direct cron.schedule, no Edge Function needed"
-- shape this app's other three original cron jobs already use
-- (escrow-expiry-sweep/auto-withdraw-sweep/reconciliation-check,
-- 20260912081331_wire_scheduled_jobs.sql) — there's no Storage object or
-- external API involved here, just a DELETE.
-- =============================================================================

create function public.fn_cleanup_rate_limit_buckets()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from rate_limit_buckets where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.fn_cleanup_rate_limit_buckets() from public, anon, authenticated;
grant execute on function public.fn_cleanup_rate_limit_buckets() to service_role;

select cron.schedule(
  'rate-limit-buckets-cleanup',
  '0 * * * *',
  $$ select public.fn_cleanup_rate_limit_buckets(); $$
);
