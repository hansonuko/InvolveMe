-- Phase 5 fraud infra, part 2 (docs/06-SECURITY-FRAUD-LOOPHOLES.md §2/§4).
--
-- fn_initiate_withdrawal already caps a Tier-1 account's daily withdrawal
-- (kyc_tier1_daily_withdrawal_cap_kobo, guard_frozen_wallets.sql) — but
-- fn_buy_credit has had no cap at all since it was first written. That's
-- the more exploitable gap today, not the already-covered one: topping up
-- needs no KYC whatsoever, so a brand-new, wholly unverified account can
-- move an unbounded amount of money in a single day. §4's own framing is
-- "capped top-up amount... for the first N days / until Tier 2 KYC" — two
-- dimensions, not just KYC tier alone, since the withdrawal side already
-- proved KYC tier alone isn't the whole story for a fresh, unverified
-- account specifically.

insert into public.pricing_config (key, value, description) values
  ('new_account_age_days', 30, 'How long an account counts as "new" for velocity-limit purposes, per docs/06-SECURITY-FRAUD-LOOPHOLES.md §4'),
  ('new_account_daily_topup_cap_kobo', 2000000, 'Daily top-up cap (pending+completed) for a new (< new_account_age_days) AND unverified (kyc_tier = 0) account — ₦20,000. Does not apply once either condition is no longer true.')
on conflict (key) do nothing;

create or replace function public.fn_buy_credit(p_user_id uuid, p_amount_kobo bigint, p_provider text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fee_bps bigint;
  v_unit_kobo bigint;
  v_fee_kobo bigint;
  v_credits bigint;
  v_topup_id uuid;
  v_kyc_tier smallint;
  v_created_at timestamptz;
  v_age_days bigint;
  v_daily_cap bigint;
  v_already_topped_up_24h bigint;
begin
  if p_amount_kobo <= 0 then
    raise exception 'invalid_amount';
  end if;

  select kyc_tier, created_at into v_kyc_tier, v_created_at from users where id = p_user_id;

  select value into v_age_days from pricing_config where key = 'new_account_age_days';
  if v_kyc_tier = 0 and v_created_at > now() - make_interval(days => v_age_days::integer) then
    select value into v_daily_cap from pricing_config where key = 'new_account_daily_topup_cap_kobo';

    select coalesce(sum(t.amount_kobo_paid), 0) into v_already_topped_up_24h
    from topups t
    where t.user_id = p_user_id
      and t.created_at > now() - interval '24 hours'
      and t.status in ('pending', 'completed');

    if v_already_topped_up_24h + p_amount_kobo > v_daily_cap then
      raise exception 'daily_topup_limit_exceeded: % already requested in 24h, cap is % for a new/unverified account', v_already_topped_up_24h, v_daily_cap;
    end if;
  end if;

  select value into v_fee_bps from pricing_config where key = 'platform_topup_fee_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

  v_fee_kobo := round(p_amount_kobo::numeric * v_fee_bps / 10000)::bigint;
  v_credits := floor((p_amount_kobo - v_fee_kobo)::numeric / v_unit_kobo)::bigint;

  insert into topups (user_id, amount_kobo_paid, platform_fee_kobo, credits_issued, provider, status)
  values (p_user_id, p_amount_kobo, v_fee_kobo, v_credits, p_provider, 'pending')
  returning id into v_topup_id;

  return v_topup_id;
end;
$$;
