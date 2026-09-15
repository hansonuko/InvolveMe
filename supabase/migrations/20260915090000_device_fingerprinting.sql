-- Phase 5 fraud infra, part 1 (docs/00-SESSION-HANDOFF.md session 13;
-- docs/06-SECURITY-FRAUD-LOOPHOLES.md §2, "the big one" — self-dealing /
-- wash-chatting via a colluding A/B pair).
--
-- users.device_fingerprint_ids (uuid[]) has existed since the very first
-- schema migration and RLS already locked it to service_role-only writes
-- (20260912072749_rls_policies.sql's "device_fingerprint_ids stay
-- service_role-only regardless of the policy above" comment) — but nothing
-- has ever backed it. No table, no writer, no reader, no mobile capture.
-- This migration is the first of those: the table + the one function
-- allowed to write to it. fn_run_collusion_detection (a later migration)
-- is what actually reads it.
--
-- device_fingerprints gets its own table, not just values pushed straight
-- into users.device_fingerprint_ids, because the signal this exists to
-- detect *is* two different users' arrays containing the same id — a
-- shared row is the fact being modeled, not an implementation detail.

create table public.device_fingerprints (
  id uuid primary key default gen_random_uuid(),
  fingerprint_hash text not null unique,
  first_seen_at timestamptz not null default now()
);

-- No RLS policy needed for direct client access — this table is never
-- queried by the client at all, only written to (via the function below)
-- and read by the collusion-detection job (service_role, bypasses RLS by
-- default). Enabling RLS with no policies is still the safer default over
-- leaving it off entirely, matching every other table in this schema.
alter table public.device_fingerprints enable row level security;

-- =============================================================================
-- fn_link_device_fingerprint — the only writer to
-- users.device_fingerprint_ids (RLS already forbids the client from
-- touching that column directly, matching kyc_tier/is_suspended's
-- treatment). Idempotent both ways: a hash seen before reuses its row
-- instead of erroring or duplicating; a user who already has that
-- fingerprint id linked is a no-op, not a duplicate array entry — a
-- device re-registering every app session (see app/_layout.tsx) must
-- never grow this array unbounded.
-- =============================================================================

create function public.fn_link_device_fingerprint(p_user_id uuid, p_fingerprint_hash text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fingerprint_id uuid;
begin
  if p_fingerprint_hash is null or length(trim(p_fingerprint_hash)) = 0 then
    raise exception 'invalid_fingerprint';
  end if;

  insert into device_fingerprints (fingerprint_hash)
  values (p_fingerprint_hash)
  on conflict (fingerprint_hash) do update set fingerprint_hash = excluded.fingerprint_hash
  returning id into v_fingerprint_id;

  update users
  set device_fingerprint_ids = array_append(device_fingerprint_ids, v_fingerprint_id)
  where id = p_user_id
    and not (device_fingerprint_ids @> array[v_fingerprint_id]);
end;
$$;

revoke execute on function public.fn_link_device_fingerprint(uuid, text) from public;
grant execute on function public.fn_link_device_fingerprint(uuid, text) to service_role;
