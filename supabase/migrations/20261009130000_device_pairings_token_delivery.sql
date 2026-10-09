-- Linked Devices Milestone 2. The session token is minted lazily, by
-- get-device-pairing-status (the web client's poll), not by
-- confirm-device-pairing (called by the phone, which has no use for its
-- own companion's session token). Single-use delivery needs its own
-- marker so a second poll after a successful pickup — or an attacker who
-- also obtained the pairing_id (the real QR-replay/shoulder-surfing risk
-- docs/12 §2 already names) — can't re-fetch the same session tokens.
alter table public.device_pairings add column tokens_delivered_at timestamptz;

-- =============================================================================
-- fn_claim_device_pairing_session — the web client's poll. Row-locked
-- (`for update`, same pattern fn_confirm_device_pairing already uses) so
-- two near-simultaneous polls can't both claim the same confirmed
-- pairing's token delivery. Returns one of five statuses rather than
-- raising, since 'pending' (keep polling) is an entirely expected,
-- frequent outcome — not an error condition the way an exception implies.
-- =============================================================================

create function public.fn_claim_device_pairing_session(p_pairing_id uuid)
returns table (status text, user_id uuid, linked_device_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pairing device_pairings;
begin
  select * into v_pairing from device_pairings where id = p_pairing_id for update;
  if not found then
    return query select 'not_found'::text, null::uuid, null::uuid;
    return;
  end if;

  if v_pairing.confirmed_at is null then
    if v_pairing.expires_at <= now() then
      return query select 'expired'::text, null::uuid, null::uuid;
    else
      return query select 'pending'::text, null::uuid, null::uuid;
    end if;
    return;
  end if;

  if v_pairing.tokens_delivered_at is not null then
    return query select 'already_delivered'::text, null::uuid, null::uuid;
    return;
  end if;

  update device_pairings set tokens_delivered_at = now() where id = p_pairing_id;

  return query select 'confirmed'::text, v_pairing.confirmed_by_user_id, v_pairing.linked_device_id;
end;
$$;

revoke execute on function public.fn_claim_device_pairing_session(uuid) from public, anon, authenticated;
grant execute on function public.fn_claim_device_pairing_session(uuid) to service_role;
