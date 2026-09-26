-- Real bug caught by e2ee-functions.test.js's own live output, not
-- assumed: Postgres's plain `encode(bytea, 'base64')` line-wraps at 76
-- characters (matching MIME/PEM convention) for any value long enough to
-- exceed that width — confirmed live: a 32-byte key encodes under the
-- wrap threshold and looked fine, but the 64-byte Ed25519 signature
-- fn_fetch_prekey_bundles returns came back with an embedded newline
-- (visible directly in a real HTTP response during testing). A base64
-- string with a stray newline is exactly the kind of thing that fails
-- unpredictably depending on how strict the receiving client's own base64
-- decoder is — worth fixing here, once, rather than trusting every future
-- encode() call site in this feature to remember to strip it.

create function public.fn_base64_encode_nowrap(p_data bytea)
returns text
language sql
immutable
set search_path = public
as $$
  select replace(encode(p_data, 'base64'), chr(10), '');
$$;

revoke execute on function public.fn_base64_encode_nowrap(bytea) from public, anon, authenticated;
grant execute on function public.fn_base64_encode_nowrap(bytea) to service_role;

-- fn_fetch_prekey_bundles: every encode() call site swapped for the
-- no-wrap helper above. Every other line is byte-for-byte unchanged from
-- 20260926160000_e2ee_schema.sql's definition.
create or replace function public.fn_fetch_prekey_bundles(p_caller_id uuid, p_target_user_id uuid)
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
      continue;
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
    identity_key_ed25519 := fn_base64_encode_nowrap(v_device.identity_key_ed25519);
    identity_key_x25519 := fn_base64_encode_nowrap(v_device.identity_key_x25519);
    signed_prekey_id := v_signed_prekey_id;
    signed_prekey_public := fn_base64_encode_nowrap(v_signed_prekey_public);
    signed_prekey_signature := fn_base64_encode_nowrap(v_signed_prekey_signature);
    one_time_prekey_id := v_otp_key_id;
    one_time_prekey_public := case when v_otp_public is not null then fn_base64_encode_nowrap(v_otp_public) else null end;

    return next;
  end loop;
end;
$$;

revoke execute on function public.fn_fetch_prekey_bundles(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_fetch_prekey_bundles(uuid, uuid) to service_role;
