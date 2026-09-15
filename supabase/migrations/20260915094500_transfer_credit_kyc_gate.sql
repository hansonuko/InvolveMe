-- Phase 5 fraud infra, part 4 (docs/06-SECURITY-FRAUD-LOOPHOLES.md §2,
-- and docs/07-COMPLIANCE-LEGAL.md §1's own flag on this exact feature).
--
-- fn_transfer_credit already checks is_frozen/is_suspended on both sides
-- and caps a single transfer (credit_transfer_max_credits), but has never
-- checked KYC tier at all — confirmed by reading its full current body,
-- not assumed. That's a real gap: fn_initiate_withdrawal has required
-- kyc_tier >= 1 since Phase 1 (nothing withdraws to an unverified
-- identity, per CLAUDE.md rule #7), but a Tier-0 recipient could still
-- accumulate withdrawable_cash via P2P transfer — money it could never
-- have earned or withdrawn through any other path in this app, sitting in
-- a wallet it genuinely can't cash out of, which is exactly the kind of
-- structural inconsistency a two-account wash-trading attempt would probe
-- for. Gating the recipient (not the sender, matching the existing "A can
-- top up without KYC" posture — the cash-out side is where the real risk
-- sits) closes it.

create or replace function public.fn_transfer_credit(
  p_sender_id uuid,
  p_recipient_id uuid,
  p_credits bigint,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_max_credits bigint;
  v_sender_wallet_id uuid;
  v_recipient_earnings_wallet_id uuid;
  v_recipient_cash_wallet_id uuid;
  v_platform_wallet_id uuid;
  v_wallet_ids uuid[];
  v_wallet_id uuid;
  v_sender_balance bigint;
  v_sender_frozen boolean;
  v_recipient_earnings_frozen boolean;
  v_recipient_cash_frozen boolean;
  v_sender_suspended boolean;
  v_recipient_suspended boolean;
  v_recipient_kyc_tier smallint;
  v_platform_cut bigint;
  v_payee_amount bigint;
  v_transfer_id uuid;
begin
  if p_credits <= 0 then
    raise exception 'invalid_amount';
  end if;

  if p_sender_id = p_recipient_id then
    raise exception 'cannot_transfer_to_self';
  end if;

  select is_suspended into v_sender_suspended from users where id = p_sender_id;
  if not found then
    raise exception 'sender_not_found';
  end if;
  if v_sender_suspended then
    raise exception 'sender_suspended';
  end if;

  select is_suspended, kyc_tier into v_recipient_suspended, v_recipient_kyc_tier
    from users where id = p_recipient_id;
  if not found then
    raise exception 'recipient_not_found';
  end if;
  if v_recipient_suspended then
    raise exception 'recipient_suspended';
  end if;
  if v_recipient_kyc_tier < 1 then
    raise exception 'recipient_kyc_required';
  end if;

  select value into v_max_credits from pricing_config where key = 'credit_transfer_max_credits';
  if p_credits > v_max_credits then
    raise exception 'amount_over_transfer_cap: max % have %', v_max_credits, p_credits;
  end if;

  select value into v_take_bps from pricing_config where key = 'platform_transfer_take_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

  select id into v_sender_wallet_id from wallets
    where user_id = p_sender_id and kind = 'topup_credit';
  select id into v_recipient_earnings_wallet_id from wallets
    where user_id = p_recipient_id and kind = 'earnings_pending';
  select id into v_recipient_cash_wallet_id from wallets
    where user_id = p_recipient_id and kind = 'withdrawable_cash';
  select id into v_platform_wallet_id from wallets
    where kind = 'platform_revenue_earnings_cut' and user_id is null;

  v_wallet_ids := array(
    select unnest(array[
      v_sender_wallet_id, v_recipient_earnings_wallet_id, v_recipient_cash_wallet_id, v_platform_wallet_id
    ]) order by 1
  );

  foreach v_wallet_id in array v_wallet_ids loop
    perform 1 from wallets where id = v_wallet_id for update;
  end loop;

  select balance, is_frozen into v_sender_balance, v_sender_frozen
    from wallets where id = v_sender_wallet_id;
  select is_frozen into v_recipient_earnings_frozen
    from wallets where id = v_recipient_earnings_wallet_id;
  select is_frozen into v_recipient_cash_frozen
    from wallets where id = v_recipient_cash_wallet_id;

  if v_sender_frozen or v_recipient_earnings_frozen or v_recipient_cash_frozen then
    raise exception 'wallet_frozen';
  end if;

  if v_sender_balance < p_credits then
    raise exception 'insufficient_credit: need % have %', p_credits, v_sender_balance;
  end if;

  v_platform_cut := round(p_credits::numeric * v_take_bps / 10000)::bigint;
  v_payee_amount := p_credits - v_platform_cut;

  insert into credit_transfers (sender_id, recipient_id, credits_sent, platform_cut_credits, credits_received, note)
  values (p_sender_id, p_recipient_id, p_credits, v_platform_cut, v_payee_amount, p_note)
  returning id into v_transfer_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_sender_wallet_id, -p_credits, 'credit_transfer_sent', 'credit_transfer', v_transfer_id);

  if v_payee_amount > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_recipient_earnings_wallet_id, v_payee_amount, 'credit_transfer_received', 'credit_transfer', v_transfer_id);

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_recipient_earnings_wallet_id, -v_payee_amount, 'credit_transfer_conversion', 'credit_transfer', v_transfer_id);

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_recipient_cash_wallet_id, v_payee_amount * v_unit_kobo, 'credit_transfer_conversion', 'credit_transfer', v_transfer_id);
  end if;

  if v_platform_cut > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_platform_wallet_id, v_platform_cut, 'credit_transfer_platform_cut', 'credit_transfer', v_transfer_id);
  end if;

  return v_transfer_id;
end;
$$;
