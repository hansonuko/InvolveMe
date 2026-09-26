-- Real end-to-end encryption, step 1 of docs/21-E2EE-TECHNICAL-DESIGN.md's
-- build order: schema + key-material/handshake functions only. No message
-- is ever encrypted as a result of this migration alone — threads.e2ee_status
-- defaults to 'off' for every thread, existing and new, and nothing in
-- fn_send_message changes yet (that's step 4). This migration is purely
-- additive and carries zero risk to any existing thread or message.
--
-- Design reference: docs/21-E2EE-TECHNICAL-DESIGN.md §1-3. Per-device
-- identity (not per-user) so multi-device works without a later schema
-- rework once docs/12 (linked devices) ships. All key material in these
-- tables is PUBLIC (identity keys, signed prekeys, one-time prekeys) —
-- private key halves never leave a device and never reach this schema at
-- all, stored only in expo-secure-store client-side.
--
-- bytea parameters are passed as base64 text over every function below,
-- decoded explicitly inside (`decode(p_x, 'base64')`) rather than relying
-- on any implicit bytea-encoding behavior from the PostgREST/supabase-js
-- layer — getting that wrong would silently corrupt key material, which
-- is a much worse failure mode (looks like "crypto doesn't work" with no
-- obvious cause) than being explicit costs in verbosity.

create table public.e2ee_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  device_label text,
  identity_key_ed25519 bytea not null,
  identity_key_x25519 bytea not null,
  registered_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index e2ee_devices_user_id_idx on public.e2ee_devices (user_id);

create table public.e2ee_signed_prekeys (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.e2ee_devices (id),
  key_id integer not null,
  public_key bytea not null,
  signature bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index e2ee_signed_prekeys_device_id_idx on public.e2ee_signed_prekeys (device_id);

create table public.e2ee_one_time_prekeys (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.e2ee_devices (id),
  key_id integer not null,
  public_key bytea not null,
  consumed_at timestamptz
);

-- The actual "claim one unused prekey" query (fn_fetch_prekey_bundles
-- below) filters on (device_id, consumed_at is null) ordered by key_id —
-- this index is exactly that access path.
create index e2ee_one_time_prekeys_available_idx
  on public.e2ee_one_time_prekeys (device_id, key_id)
  where consumed_at is null;

alter table public.threads add column e2ee_status text not null default 'off'
  check (e2ee_status in ('off', 'active'));
-- 'off' (default, every existing thread): completely unchanged legacy
-- plaintext path. 'active': every new message in this thread is
-- encrypted, no per-message opt-out — a thread-level switch that only
-- ever moves forward (docs/21 §2/§6), never both ways.

alter table public.messages alter column body drop not null;
-- An 'active'-thread message stores no plaintext body at all — the real
-- content lives exclusively in e2ee_message_envelopes below. Enforcing
-- "body is null XOR envelopes exist" as a real constraint would need a
-- cross-table CHECK, which Postgres doesn't support directly (would need
-- a trigger) — fn_send_message (step 4) is the actual enforcement point
-- for this invariant, same posture this codebase already takes for every
-- other cross-row invariant enforced in a SECURITY DEFINER function
-- rather than a constraint.

create table public.e2ee_message_envelopes (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id),
  recipient_device_id uuid not null references public.e2ee_devices (id),
  ciphertext bytea not null,
  ratchet_public_key bytea not null,
  previous_chain_length integer not null,
  message_number integer not null,
  -- Present only on the envelope that is the first message of a brand-new
  -- X3DH session with this specific recipient device — null otherwise.
  x3dh_sender_identity_key bytea,
  x3dh_sender_ephemeral_key bytea,
  x3dh_one_time_prekey_id integer,
  created_at timestamptz not null default now()
);

create index e2ee_message_envelopes_message_id_idx on public.e2ee_message_envelopes (message_id);
create index e2ee_message_envelopes_recipient_device_idx
  on public.e2ee_message_envelopes (recipient_device_id);

-- =============================================================================
-- RLS. Identity keys and prekeys are public data, but this app's own
-- existing convention (users_select_own_or_thread_partner,
-- find-user-by-phone's header comment) is "visible to an existing thread
-- partner, never an arbitrary stranger" — matched here rather than making
-- device/key lookups a new, broader enumeration surface than anything else
-- in this app allows. e2ee_signed_prekeys/e2ee_one_time_prekeys get no
-- direct client SELECT policy at all (no legitimate direct-read need —
-- fn_fetch_prekey_bundles is the only path to them, same "no policy,
-- function-only access" posture rate_limit_buckets already established
-- this session).
-- =============================================================================

alter table public.e2ee_devices enable row level security;

create policy e2ee_devices_select_own_or_thread_partner on public.e2ee_devices
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.threads t
      where (t.participant_a = auth.uid() and t.participant_b = e2ee_devices.user_id)
         or (t.participant_b = auth.uid() and t.participant_a = e2ee_devices.user_id)
    )
  );

alter table public.e2ee_signed_prekeys enable row level security;
alter table public.e2ee_one_time_prekeys enable row level security;

-- A device's owner can read their own envelopes (both as the intended
-- recipient of a message from someone else, and as one of the sender's
-- OWN additional devices in a multi-device fan-out — both cases are
-- exactly "recipient_device_id belongs to me", no separate mechanism
-- needed for self-sync).
alter table public.e2ee_message_envelopes enable row level security;

create policy e2ee_message_envelopes_select_own_device on public.e2ee_message_envelopes
  for select
  to authenticated
  using (
    exists (
      select 1 from public.e2ee_devices d
      where d.id = e2ee_message_envelopes.recipient_device_id and d.user_id = auth.uid()
    )
  );

-- =============================================================================
-- fn_register_e2ee_device — called once per device on E2EE first-time
-- setup. p_one_time_prekeys is a jsonb array of {"key_id": int,
-- "public_key": "<base64>"} objects — the initial pool; fn_replenish_one_
-- time_prekeys tops it up later as it's consumed.
-- =============================================================================

create function public.fn_register_e2ee_device(
  p_user_id uuid,
  p_device_label text,
  p_identity_key_ed25519 text,
  p_identity_key_x25519 text,
  p_signed_prekey_id integer,
  p_signed_prekey_public text,
  p_signed_prekey_signature text,
  p_signed_prekey_expires_at timestamptz,
  p_one_time_prekeys jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device_id uuid;
  v_prekey jsonb;
begin
  insert into e2ee_devices (user_id, device_label, identity_key_ed25519, identity_key_x25519)
  values (
    p_user_id, p_device_label,
    decode(p_identity_key_ed25519, 'base64'),
    decode(p_identity_key_x25519, 'base64')
  )
  returning id into v_device_id;

  insert into e2ee_signed_prekeys (device_id, key_id, public_key, signature, expires_at)
  values (
    v_device_id, p_signed_prekey_id,
    decode(p_signed_prekey_public, 'base64'),
    decode(p_signed_prekey_signature, 'base64'),
    p_signed_prekey_expires_at
  );

  for v_prekey in select * from jsonb_array_elements(p_one_time_prekeys)
  loop
    insert into e2ee_one_time_prekeys (device_id, key_id, public_key)
    values (
      v_device_id,
      (v_prekey->>'key_id')::integer,
      decode(v_prekey->>'public_key', 'base64')
    );
  end loop;

  return v_device_id;
end;
$$;

revoke execute on function public.fn_register_e2ee_device(
  uuid, text, text, text, integer, text, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.fn_register_e2ee_device(
  uuid, text, text, text, integer, text, text, timestamptz, jsonb
) to service_role;

-- =============================================================================
-- fn_fetch_prekey_bundles — the X3DH handshake's read path. Returns one
-- row per active device the target user has, atomically claiming one
-- one-time prekey per device (row-locked, skip-locked — two concurrent
-- callers can never claim the same one-time prekey twice, same discipline
-- every wallet-touching function in this app already uses for its own row
-- locks). A device whose signed prekey has expired is skipped outright — a
-- session can't be safely started against a prekey nobody vouches for
-- anymore. one_time_prekey_id/public are null (not an error) when a
-- device's pool is exhausted — X3DH degrades gracefully without a
-- one-time prekey, per spec; the missing DH term is simply omitted.
--
-- Gated on caller/target sharing an existing thread — matches this app's
-- own established "visible to a thread partner, not an arbitrary
-- stranger" posture (users_select_own_or_thread_partner,
-- find-user-by-phone), not a new enumeration surface.
-- =============================================================================

create function public.fn_fetch_prekey_bundles(p_caller_id uuid, p_target_user_id uuid)
returns table(
  device_id uuid,
  identity_key_ed25519 text,
  identity_key_x25519 text,
  signed_prekey_id integer,
  signed_prekey_public text,
  signed_prekey_signature text,
  one_time_prekey_id integer,
  one_time_prekey_public text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device record;
  v_signed_prekey_id integer;
  v_signed_prekey_public bytea;
  v_signed_prekey_signature bytea;
  v_otp_pk_id uuid;
  v_otp_key_id integer;
  v_otp_public bytea;
begin
  if p_caller_id = p_target_user_id then
    raise exception 'cannot_fetch_own_bundle';
  end if;

  if not exists (
    select 1 from threads
    where (participant_a = p_caller_id and participant_b = p_target_user_id)
       or (participant_b = p_caller_id and participant_a = p_target_user_id)
  ) then
    raise exception 'not_a_thread_partner';
  end if;

  for v_device in
    select * from e2ee_devices
    where user_id = p_target_user_id and revoked_at is null
    order by registered_at
  loop
    v_signed_prekey_id := null;
    v_signed_prekey_public := null;
    v_signed_prekey_signature := null;

    select key_id, public_key, signature
      into v_signed_prekey_id, v_signed_prekey_public, v_signed_prekey_signature
      from e2ee_signed_prekeys
      where e2ee_signed_prekeys.device_id = v_device.id and expires_at > now()
      order by created_at desc
      limit 1;

    if v_signed_prekey_id is null then
      continue; -- no valid signed prekey — this device can't be handshaked with right now
    end if;

    v_otp_pk_id := null;
    v_otp_key_id := null;
    v_otp_public := null;

    select id, key_id, public_key into v_otp_pk_id, v_otp_key_id, v_otp_public
      from e2ee_one_time_prekeys
      where e2ee_one_time_prekeys.device_id = v_device.id and consumed_at is null
      order by key_id
      limit 1
      for update skip locked;

    if v_otp_pk_id is not null then
      update e2ee_one_time_prekeys set consumed_at = now() where id = v_otp_pk_id;
    end if;

    device_id := v_device.id;
    identity_key_ed25519 := encode(v_device.identity_key_ed25519, 'base64');
    identity_key_x25519 := encode(v_device.identity_key_x25519, 'base64');
    signed_prekey_id := v_signed_prekey_id;
    signed_prekey_public := encode(v_signed_prekey_public, 'base64');
    signed_prekey_signature := encode(v_signed_prekey_signature, 'base64');
    one_time_prekey_id := v_otp_key_id;
    one_time_prekey_public := case when v_otp_public is not null then encode(v_otp_public, 'base64') else null end;

    return next;
  end loop;
end;
$$;

revoke execute on function public.fn_fetch_prekey_bundles(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_fetch_prekey_bundles(uuid, uuid) to service_role;

-- =============================================================================
-- fn_replenish_one_time_prekeys — self-only (a device can only top up its
-- own pool). p_new_prekeys is the same jsonb-array shape
-- fn_register_e2ee_device's initial batch uses.
-- =============================================================================

create function public.fn_replenish_one_time_prekeys(
  p_caller_id uuid,
  p_device_id uuid,
  p_new_prekeys jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
  v_prekey jsonb;
  v_inserted integer := 0;
begin
  select user_id into v_owner_id from e2ee_devices where id = p_device_id;
  if not found then
    raise exception 'device_not_found';
  end if;
  if v_owner_id <> p_caller_id then
    raise exception 'not_your_device';
  end if;

  for v_prekey in select * from jsonb_array_elements(p_new_prekeys)
  loop
    insert into e2ee_one_time_prekeys (device_id, key_id, public_key)
    values (
      p_device_id,
      (v_prekey->>'key_id')::integer,
      decode(v_prekey->>'public_key', 'base64')
    );
    v_inserted := v_inserted + 1;
  end loop;

  return v_inserted;
end;
$$;

revoke execute on function public.fn_replenish_one_time_prekeys(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.fn_replenish_one_time_prekeys(uuid, uuid, jsonb) to service_role;

-- =============================================================================
-- fn_enable_e2ee — flips a thread's e2ee_status to 'active'. Gated on BOTH
-- participants already having at least one registered, non-revoked
-- device — a thread can't be marked active if one side could never
-- possibly receive an encrypted message, which would otherwise silently
-- strand every future send. Idempotent (already-active is a no-op, not an
-- error) — participant-only.
-- =============================================================================

create function public.fn_enable_e2ee(p_thread_id uuid, p_caller_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
begin
  select * into v_thread from threads where id = p_thread_id for update;
  if not found then
    raise exception 'thread_not_found';
  end if;

  if p_caller_id not in (v_thread.participant_a, v_thread.participant_b) then
    raise exception 'not_a_participant';
  end if;

  if v_thread.e2ee_status = 'active' then
    return;
  end if;

  if not exists (select 1 from e2ee_devices where user_id = v_thread.participant_a and revoked_at is null) then
    raise exception 'participant_a_has_no_e2ee_device';
  end if;
  if not exists (select 1 from e2ee_devices where user_id = v_thread.participant_b and revoked_at is null) then
    raise exception 'participant_b_has_no_e2ee_device';
  end if;

  update threads set e2ee_status = 'active' where id = p_thread_id;
end;
$$;

revoke execute on function public.fn_enable_e2ee(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_enable_e2ee(uuid, uuid) to service_role;
