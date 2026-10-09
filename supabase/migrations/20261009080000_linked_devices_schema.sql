-- Linked Devices (WhatsApp-Web-style QR pairing), Milestone 1 of
-- docs/12-LINKED-DEVICES-WEB-SCOPING.md — schema + SECURITY DEFINER
-- functions only, no Edge Functions yet (Milestone 2). Session already
-- carries: `involveme-web` is being rebuilt as a reduced-trust companion
-- client, paired by scanning a QR code from an already-logged-in phone —
-- not the full standalone OTP-login PWA docs/22 originally built it as.
-- Cap is 5 linked devices (real WhatsApp: 4 companions + primary),
-- correcting this doc's own earlier "one device" placeholder.
--
-- Milestone 0 (live-verified against this project's real dev DB before
-- writing any of this) resolved docs/12 §2's one open technical question:
-- no Supabase Auth Admin API path exists for minting a session on a phone-
-- only-auth project (admin.generateLink is entirely email-based). The real
-- mechanism, with existing precedent already in this exact repo
-- (supabase/tests/*.test.js already manually signs HS256 JWTs with
-- SUPABASE_JWT_SECRET to call Edge Functions as an arbitrary user) is a
-- stateless, self-signed access token — confirmed live that a real
-- @supabase/supabase-js client's setSession() accepts one with no error,
-- and that auth.uid() resolves correctly server-side afterward (not just a
-- client-side illusion). No auth.sessions/auth.refresh_tokens row ever
-- gets written for a linked device's session; it's a bare, stateless JWT.
--
-- Because of that, there is no native "session_id" to key revocation off.
-- Instead, the Edge Function that mints a linked device's token (Milestone
-- 2) embeds a custom `linked_device_id` claim directly in the signed
-- payload — this table's own `linked_devices.id`. A primary phone session
-- (real signInWithOtp, GoTrue-issued) never carries this claim at all, so
-- it's a safe, unambiguous signal. Revoking is simply setting
-- `revoked_at` here; any Edge Function wanting the reduced-privilege gate
-- (Milestone 3) decodes the bearer token's own payload (no network call)
-- and checks the claim, if present, against a live, unrevoked row here.

create table public.linked_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  label text not null,
  platform text,
  linked_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index linked_devices_user_id_idx on public.linked_devices (user_id);

-- A short-lived, single-use row — the id itself is the QR payload
-- (already unguessable, gen_random_uuid(), no separate token needed).
-- `device_label`/`platform` are supplied by the unauthenticated web client
-- at creation time (from its own navigator.userAgent), stored here so the
-- phone's "Link this device?" confirm screen can show something real
-- ("Chrome on Windows") rather than a bare id.
create table public.device_pairings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  device_label text not null,
  platform text,
  confirmed_by_user_id uuid references public.users (id),
  confirmed_at timestamptz,
  linked_device_id uuid references public.linked_devices (id)
);

create index device_pairings_expires_at_idx on public.device_pairings (expires_at);
-- Scheduled cleanup of expired/unconfirmed rows (docs/12 §3 flags this as
-- worth a pg_cron sweep, same as this app's other scheduled jobs) is not
-- built in this migration — expiry is already correctly enforced by
-- fn_confirm_device_pairing's own check below regardless of whether a
-- stale row is ever deleted; this index exists for that future sweep.

-- =============================================================================
-- RLS — select-only for self-owned rows, matching e2ee_devices' own
-- convention (20260926160000_e2ee_schema.sql): every write goes through a
-- SECURITY DEFINER function below, never an RLS insert/update policy.
-- device_pairings has no select policy at all for anon/authenticated —
-- the unauthenticated web client never reads this table directly, only
-- through fn_create_device_pairing/the pairing-status Edge Function
-- (Milestone 2), same "no policy, function-only access" posture
-- rate_limit_buckets already established.
-- =============================================================================

alter table public.linked_devices enable row level security;

create policy linked_devices_select_own on public.linked_devices
  for select
  to authenticated
  using (user_id = auth.uid());

alter table public.device_pairings enable row level security;

-- =============================================================================
-- pricing_config — tunable knobs, not constants, per this app's standing
-- convention (CLAUDE.md rule #9; same pattern message_audio_max_seconds
-- already uses for a non-pricing cap living in this same table).
-- =============================================================================

insert into public.pricing_config (key, currency, value, description) values
  ('device_pairing_expiry_seconds', 'NGN', 60,
   'How long a QR-code device-pairing request (docs/12-LINKED-DEVICES-WEB-SCOPING.md) stays scannable before it hard-expires — matches real WhatsApp Web''s own roughly-one-minute QR lifetime.'),
  ('device_pairing_max_linked_devices', 'NGN', 5,
   'Hard cap on how many linked (companion, non-primary) devices one account can have active at once — matches real WhatsApp Web''s own cap of 4 companions + the primary phone.')
on conflict (key, currency) do nothing;

-- =============================================================================
-- fn_create_device_pairing — called by the unauthenticated web client the
-- moment the QR-pairing screen loads. No p_user_id: nobody is identified
-- yet, that's the whole point of this table.
-- =============================================================================

create function public.fn_create_device_pairing(
  p_device_label text,
  p_platform text
)
returns table (id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expiry_seconds bigint;
begin
  select value into v_expiry_seconds
    from pricing_config where key = 'device_pairing_expiry_seconds' and currency = 'NGN';
  if v_expiry_seconds is null then
    raise exception 'pricing_config_not_found: device_pairing_expiry_seconds';
  end if;

  return query
    insert into device_pairings (expires_at, device_label, platform)
    values (now() + make_interval(secs => v_expiry_seconds), p_device_label, p_platform)
    returning device_pairings.id, device_pairings.expires_at;
end;
$$;

revoke execute on function public.fn_create_device_pairing(text, text) from public, anon, authenticated;
grant execute on function public.fn_create_device_pairing(text, text) to service_role;

-- =============================================================================
-- fn_confirm_device_pairing — called by the PHONE (already-authenticated,
-- real session) after scanning the QR and confirming "Link this device?".
-- Row-locks the pairing (`for update`, same pattern every other
-- concurrency-sensitive function in this app already uses) so two
-- near-simultaneous confirm taps against the same pairing_id can't both
-- succeed — the second always sees already_confirmed after the lock
-- releases, never a silent double-link.
-- =============================================================================

create function public.fn_confirm_device_pairing(
  p_pairing_id uuid,
  p_user_id uuid,
  p_platform text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pairing device_pairings;
  v_max_devices bigint;
  v_current_count bigint;
  v_linked_device_id uuid;
begin
  select * into v_pairing from device_pairings where id = p_pairing_id for update;
  if not found then
    raise exception 'pairing_not_found';
  end if;
  if v_pairing.expires_at <= now() then
    raise exception 'pairing_expired';
  end if;
  if v_pairing.confirmed_at is not null then
    raise exception 'pairing_already_confirmed';
  end if;

  select value into v_max_devices
    from pricing_config where key = 'device_pairing_max_linked_devices' and currency = 'NGN';
  if v_max_devices is null then
    raise exception 'pricing_config_not_found: device_pairing_max_linked_devices';
  end if;

  select count(*) into v_current_count
    from linked_devices where user_id = p_user_id and revoked_at is null;
  if v_current_count >= v_max_devices then
    raise exception 'max_linked_devices_reached';
  end if;

  insert into linked_devices (user_id, label, platform)
  values (p_user_id, v_pairing.device_label, p_platform)
  returning id into v_linked_device_id;

  update device_pairings
  set confirmed_by_user_id = p_user_id,
      confirmed_at = now(),
      linked_device_id = v_linked_device_id
  where id = p_pairing_id;

  return v_linked_device_id;
end;
$$;

revoke execute on function public.fn_confirm_device_pairing(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_confirm_device_pairing(uuid, uuid, text) to service_role;

-- =============================================================================
-- fn_list_linked_devices — backs the mobile "Linked Devices" settings
-- screen (Milestone 5). Only ever-active (unrevoked) devices — a revoked
-- one conceptually disappears from this list, same as it would from real
-- WhatsApp's own Linked Devices screen.
-- =============================================================================

create function public.fn_list_linked_devices(p_user_id uuid)
returns setof linked_devices
language sql
security definer
set search_path = public
as $$
  select * from linked_devices
  where user_id = p_user_id and revoked_at is null
  order by linked_at desc;
$$;

revoke execute on function public.fn_list_linked_devices(uuid) from public, anon, authenticated;
grant execute on function public.fn_list_linked_devices(uuid) to service_role;

-- =============================================================================
-- fn_revoke_linked_device — p_linked_device_id null means "revoke every
-- active linked device for this user" (the "log out of all other
-- devices" bulk action, docs/12 §2) rather than a second function for
-- what's otherwise the identical operation. Ownership-checked either way
-- (the where clause already scopes to p_user_id, so a non-null id
-- belonging to a different user simply matches zero rows, not an error —
-- same "can't distinguish not-found from not-yours" posture this app
-- already accepts elsewhere for exactly this reason, since an error
-- message differing by case would leak whether an id exists at all).
-- =============================================================================

create function public.fn_revoke_linked_device(
  p_user_id uuid,
  p_linked_device_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update linked_devices
  set revoked_at = now()
  where user_id = p_user_id
    and revoked_at is null
    and (p_linked_device_id is null or id = p_linked_device_id);
end;
$$;

revoke execute on function public.fn_revoke_linked_device(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_revoke_linked_device(uuid, uuid) to service_role;
