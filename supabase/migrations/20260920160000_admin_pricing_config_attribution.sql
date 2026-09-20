-- Admin dashboard Phase D piece 1 (docs/14-ADMIN-DASHBOARD-SCOPING.md §4.2)
-- — real per-admin attribution on pricing_config changes, and the one
-- SECURITY DEFINER function the editor UI (piece 2) writes through.
--
-- Corrected finding, on record in docs/14 §2/§4.2: pricing_config_history
-- already exists and its trigger (record_pricing_config_change,
-- 20260912070729_create_core_schema.sql) already auto-captures old/new
-- values correctly on every pricing_config UPDATE — it just hardcodes
-- changed_by to the literal 'system', with no way for a caller to
-- attribute a real actor. This migration is that fix, not a rebuild of
-- something that was never assumed to exist.
--
-- Approach: a transaction-local Postgres setting (`set_config(...,
-- is_local => true)`), not a session-scoped one — this project's DB
-- connections go through Supabase's pooler, and a session-scoped setting
-- could leak into a LATER, unrelated query on the same pooled connection
-- if nothing ever reset it. Transaction-local is automatically cleared at
-- commit, so it's only ever visible to the exact UPDATE that set it and
-- the trigger that fires from it, in the same transaction.
create or replace function public.record_pricing_config_change()
returns trigger
language plpgsql
as $$
begin
  insert into public.pricing_config_history (key, currency, old_value, new_value, changed_by)
  values (
    new.key,
    new.currency,
    old.value,
    new.value,
    coalesce(nullif(current_setting('app.admin_actor', true), ''), 'system')
  );

  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- fn_admin_update_pricing_config — the only sanctioned way the admin
-- backend changes a pricing_config value. Two sanity guards the column's
-- own bare `bigint not null` never enforced: a `_bps` key can't be set
-- above 10000 (100%) — nothing stops a typo'd extra zero on a take-rate
-- otherwise — and no key can go negative, since none of the 30 keys that
-- exist today have any legitimate negative value.
-- =============================================================================

create function public.fn_admin_update_pricing_config(
  p_actor_admin_id uuid,
  p_key text,
  p_currency text,
  p_new_value bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_email text;
  v_updated_rows int;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'edit_pricing_config') then
    raise exception 'not_authorized';
  end if;

  if p_new_value < 0 then
    raise exception 'negative_value_not_allowed';
  end if;

  if right(p_key, 4) = '_bps' and p_new_value > 10000 then
    raise exception 'bps_value_out_of_range: % exceeds 10000 (100 percent)', p_new_value;
  end if;

  select email into v_actor_email from admin_users where id = p_actor_admin_id;

  perform set_config('app.admin_actor', v_actor_email, true);

  update pricing_config set value = p_new_value where key = p_key and currency = p_currency;
  get diagnostics v_updated_rows = row_count;

  if v_updated_rows = 0 then
    raise exception 'pricing_config_key_not_found';
  end if;

  insert into public.admin_audit_log (admin_user_id, action, target_type, target_id, after_state)
  values (
    p_actor_admin_id,
    'update_pricing_config',
    'pricing_config',
    p_key || ':' || p_currency,
    jsonb_build_object('new_value', p_new_value)
  );
end;
$$;

revoke execute on function public.fn_admin_update_pricing_config(uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.fn_admin_update_pricing_config(uuid, text, text, bigint) to service_role;
