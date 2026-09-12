-- fn_post_status — the one piece of DB work docs/00-SESSION-HANDOFF.md
-- flagged as fully buildable with no Flutterwave dependency: debits credit
-- for a status upload, per docs/03-ECONOMY-LEDGER.md §7. No escrow, no
-- earning — nobody "responds" to a status the way a thread reply does, so
-- this is a single-wallet debit, the simplest shape in the function set
-- (closest to fn_buy_credit, minus the provider round trip).
--
-- Same conventions as every other SECURITY DEFINER function here: locks the
-- payer's topup_credit wallet FOR UPDATE, checks is_frozen (per the
-- guard-frozen-wallets migration — freeze must mean freeze everywhere, not
-- "everywhere except the newest function"), reads pricing_config rather than
-- hardcoding credit amounts, and records the debit as a ledger_entries row
-- rather than touching wallets.balance directly. status_upload_debit
-- (reason) and status_update (ref_type) already exist in the item-1 CHECK
-- constraints — nothing to add there.
--
-- Credit amount depends on whether media is attached: status_upload_credits_
-- text vs. _media, per docs/03 §7. A status needs at least a caption or a
-- media_url — an empty status has nothing to charge for and nothing to show.
--
-- expires_at is fixed at 24h per docs/02-DATA-MODEL.md's status_updates
-- column comment and docs/05-API-REALTIME-SPEC.md's post-status contract —
-- not read from pricing_config, since nothing documents it as tunable and no
-- other status-lifetime value exists to justify adding one speculatively.

create function public.fn_post_status(p_user_id uuid, p_media_url text, p_caption text)
returns table (
  status_id uuid,
  credits_charged bigint,
  payer_balance_after bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text_credits bigint;
  v_media_credits bigint;
  v_credits bigint;
  v_has_media boolean;
  v_wallet_id uuid;
  v_balance bigint;
  v_frozen boolean;
  v_status_id uuid;
begin
  v_has_media := p_media_url is not null and length(trim(both from p_media_url)) > 0;

  if not v_has_media and (p_caption is null or length(trim(both from p_caption)) = 0) then
    raise exception 'empty_status';
  end if;

  select value into v_text_credits from pricing_config where key = 'status_upload_credits_text';
  select value into v_media_credits from pricing_config where key = 'status_upload_credits_media';

  v_credits := case when v_has_media then v_media_credits else v_text_credits end;

  select id, balance, is_frozen into v_wallet_id, v_balance, v_frozen
  from wallets
  where user_id = p_user_id and kind = 'topup_credit'
  for update;

  if not found then
    raise exception 'wallet_not_found';
  end if;

  if v_frozen then
    raise exception 'wallet_frozen';
  end if;

  if v_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_balance;
  end if;

  insert into status_updates (user_id, media_url, caption, credits_charged, expires_at)
  values (p_user_id, p_media_url, p_caption, v_credits, now() + interval '24 hours')
  returning id into v_status_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_wallet_id, -v_credits, 'status_upload_debit', 'status_update', v_status_id);

  select balance into v_balance from wallets where id = v_wallet_id;

  return query select v_status_id, v_credits, v_balance;
end;
$$;

revoke execute on function public.fn_post_status(uuid, text, text) from public;
grant execute on function public.fn_post_status(uuid, text, text) to service_role;
