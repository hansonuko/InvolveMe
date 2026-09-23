-- Admin dashboard Phase E piece 2 (docs/14-ADMIN-DASHBOARD-SCOPING.md §4.4)
-- — wires the piece 1 dual-approval engine into two real actions:
--
--   1. Retrofits fn_admin_update_pricing_config (Phase D): any `_bps` key
--      change (the materiality example §4.2 itself names — "any change to
--      a take-rate bps value, ever") now requires a matching
--      approved-and-unexpired admin_pending_actions row before it
--      applies. Non-bps keys keep applying immediately, unchanged —
--      per §4.2's own "a message_base_credits tweak might not need it."
--      This is a real, deliberate behavior change: confirmed directly
--      (20260920160000_admin_pricing_config_attribution.sql) that the
--      function currently applies every change immediately with zero
--      gate. The existing Phase D pricing editor UI calls this function
--      with 4 named args via supabase-js's RPC (named-argument call, not
--      positional) — adding a 5th, defaulted `p_pending_action_id`
--      parameter is backward compatible for non-bps edits; a bps edit
--      through the current UI will now get a clear `dual_approval_required`
--      exception instead of applying silently, until piece 3 adds the
--      real propose/approve UI. Old 4-arg signature is dropped and
--      replaced rather than left as a dead overload, so there is exactly
--      one way to call this function going forward.
--
--   2. fn_admin_post_manual_adjustment — the first-ever function anywhere
--      in this codebase that lets an admin post a manual ledger
--      adjustment (confirmed directly — grepped every migration, nothing
--      writes `manual_adjustment` except the reason enum itself and this
--      migration). Because it's a first build, not a retrofit, it ships
--      dual-approval-gated unconditionally, no materiality floor — same
--      posture docs/14 §5 already uses for platform treasury withdrawals
--      ("every one requires two admins, no exceptions"), for the same
--      reason: a brand-new hand-authored money-moving path is exactly
--      the kind of thing that shouldn't get a "small amounts are fine
--      solo" carve-out on day one.
--
-- Both functions redeem their approval via piece 1's
-- fn_admin_consume_approved_pending_action and then verify the consumed
-- payload matches the actual call arguments field-for-field
-- (pending_action_payload_mismatch otherwise) — approving "raise
-- platform_topup_fee_bps to 500" must not be usable to justify applying
-- some other change. A mismatch still burns the approval (single-use by
-- design); that's a deliberate fail-closed tradeoff, not a bug — it never
-- lets an unapproved action through, it only means a caller that passes
-- the wrong arguments has to propose again, which is the safe direction
-- to fail in.
--
-- fn_admin_post_manual_adjustment reuses the exact wallet-locking +
-- ledger_entries-insert pattern every other money-moving function in this
-- codebase already uses (see fn_transfer_credit,
-- 20260913091500_credit_transfer_between_users.sql): lock the target
-- wallet row, check frozen + sufficient-balance-to-not-go-negative, then
-- INSERT into ledger_entries — wallets.balance updates itself via the
-- existing ledger_entries_apply_to_wallet trigger, never a direct
-- UPDATE. currency is read from the wallet, never accepted as a separate
-- admin-supplied argument — 20260917130000_multicurrency_schema.sql's own
-- header comment warns a mismatch here would silently break the
-- per-currency reconciliation invariant.

-- ref_type gets one new value so a manual adjustment's ledger_entries row
-- can point straight back at the admin_pending_actions row that
-- authorized it (ref_id) — same widen-the-check-constraint precedent this
-- table has already been through twice (credit_transfer, group_message).
alter table public.ledger_entries drop constraint ledger_entries_ref_type_check;
alter table public.ledger_entries add constraint ledger_entries_ref_type_check
  check (ref_type in ('message', 'topup', 'withdrawal', 'escrow', 'status_update', 'credit_transfer', 'group_message', 'admin_action'));

-- =============================================================================
-- fn_admin_update_pricing_config — dropped and recreated with the new
-- trailing p_pending_action_id parameter (Postgres treats an added
-- parameter as a new signature; CREATE OR REPLACE can't extend an
-- existing function's argument list in place). Grant lock re-applied
-- below on the new signature per CLAUDE.md rule #11 — the old signature's
-- grants go away with the DROP, there is nothing left to leak.
-- =============================================================================

drop function public.fn_admin_update_pricing_config(uuid, text, text, bigint);

create function public.fn_admin_update_pricing_config(
  p_actor_admin_id uuid,
  p_key text,
  p_currency text,
  p_new_value bigint,
  p_pending_action_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_email text;
  v_updated_rows int;
  v_is_material boolean;
  v_payload jsonb;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'edit_pricing_config') then
    raise exception 'not_authorized';
  end if;

  if p_new_value < 0 then
    raise exception 'negative_value_not_allowed';
  end if;

  v_is_material := right(p_key, 4) = '_bps';

  if v_is_material and p_new_value > 10000 then
    raise exception 'bps_value_out_of_range: % exceeds 10000 (100 percent)', p_new_value;
  end if;

  if v_is_material then
    if p_pending_action_id is null then
      raise exception 'dual_approval_required: propose this bps change via fn_admin_propose_pending_action first';
    end if;

    v_payload := public.fn_admin_consume_approved_pending_action(p_pending_action_id, 'pricing_config_update');

    if v_payload->>'key' is distinct from p_key
       or v_payload->>'currency' is distinct from p_currency
       or (v_payload->>'new_value')::bigint is distinct from p_new_value
    then
      raise exception 'pending_action_payload_mismatch';
    end if;
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
    jsonb_build_object('new_value', p_new_value, 'pending_action_id', p_pending_action_id)
  );
end;
$$;

revoke execute on function public.fn_admin_update_pricing_config(uuid, text, text, bigint, uuid) from public, anon, authenticated;
grant execute on function public.fn_admin_update_pricing_config(uuid, text, text, bigint, uuid) to service_role;

-- =============================================================================
-- fn_admin_post_manual_adjustment — first-ever build, dual-approval-gated
-- from birth (no p_pending_action_id default, no bypass path at all).
-- =============================================================================

create function public.fn_admin_post_manual_adjustment(
  p_actor_admin_id uuid,
  p_pending_action_id uuid,
  p_wallet_id uuid,
  p_amount bigint,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_actor_email text;
  v_wallet_currency text;
  v_wallet_frozen boolean;
  v_wallet_balance bigint;
  v_entry_id uuid;
begin
  if not public.fn_admin_check_permission(p_actor_admin_id, 'post_manual_adjustment') then
    raise exception 'not_authorized';
  end if;

  if p_amount = 0 then
    raise exception 'invalid_amount';
  end if;

  if p_note is null or length(trim(p_note)) = 0 then
    raise exception 'note_required';
  end if;

  v_payload := public.fn_admin_consume_approved_pending_action(p_pending_action_id, 'manual_ledger_adjustment');

  if (v_payload->>'wallet_id')::uuid is distinct from p_wallet_id
     or (v_payload->>'amount')::bigint is distinct from p_amount
     or coalesce(v_payload->>'note', '') is distinct from coalesce(p_note, '')
  then
    raise exception 'pending_action_payload_mismatch';
  end if;

  select currency, is_frozen, balance into v_wallet_currency, v_wallet_frozen, v_wallet_balance
  from public.wallets where id = p_wallet_id for update;

  if not found then
    raise exception 'wallet_not_found';
  end if;

  if v_wallet_frozen then
    raise exception 'wallet_frozen';
  end if;

  if v_wallet_balance + p_amount < 0 then
    raise exception 'insufficient_balance_for_adjustment: wallet balance % adjustment % would go negative', v_wallet_balance, p_amount;
  end if;

  select email into v_actor_email from admin_users where id = p_actor_admin_id;

  insert into public.ledger_entries (wallet_id, amount, reason, ref_type, ref_id, currency, created_by)
  values (p_wallet_id, p_amount, 'manual_adjustment', 'admin_action', p_pending_action_id, v_wallet_currency, v_actor_email)
  returning id into v_entry_id;

  perform public.fn_admin_log_action(
    p_actor_admin_id,
    'post_manual_adjustment',
    'ledger_entries',
    v_entry_id::text,
    null,
    jsonb_build_object('wallet_id', p_wallet_id, 'amount', p_amount, 'note', p_note, 'pending_action_id', p_pending_action_id),
    null
  );

  return v_entry_id;
end;
$$;

revoke execute on function public.fn_admin_post_manual_adjustment(uuid, uuid, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.fn_admin_post_manual_adjustment(uuid, uuid, uuid, bigint, text) to service_role;
