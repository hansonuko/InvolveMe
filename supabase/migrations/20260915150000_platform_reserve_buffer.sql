-- Reserve buffer (docs/06-SECURITY-FRAUD-LOOPHOLES.md §3, "build now" bullet
-- 3): hold back a small % of every platform-revenue credit into a rolling
-- self-insurance pool, so the platform isn't caught with zero buffer the
-- first time a chargeback/reversal lands (see the companion clawback
-- migration, 20260915151500_chargeback_clawback.sql, for the other half).
--
-- Two new platform-owned wallet kinds, mirroring the existing kobo/credits
-- unit split from 20260912072739_extend_schema_for_functions.sql exactly —
-- a single blended reserve wallet would silently mix units the same way a
-- single 'platform_revenue' wallet would have:
--   - platform_reserve_topup_fees (kobo) — skimmed from platform_revenue_topup_fees
--   - platform_reserve_earnings_cut (credits) — skimmed from platform_revenue_earnings_cut
--
-- fn_credit_platform_revenue() is the one place the split happens; every
-- function that credits platform revenue is redefined below to call it
-- instead of inserting into the revenue wallet directly, so every current
-- and future revenue-crediting site gets the skim automatically and
-- correctly (same net+reserve always sums to the original amount — no
-- independent rounding on each side). It runs inside the caller's own
-- transaction (a plpgsql function call has no transaction boundary of its
-- own), so this satisfies CLAUDE.md rule #3 without restructuring anything.

alter table public.wallets drop constraint wallets_kind_check;
alter table public.wallets drop constraint wallets_platform_wallet_has_no_user;

alter table public.wallets add constraint wallets_kind_check check (
  kind in (
    'topup_credit', 'earnings_pending', 'withdrawable_cash',
    'platform_revenue_topup_fees', 'platform_revenue_earnings_cut',
    'platform_reserve_topup_fees', 'platform_reserve_earnings_cut'
  )
);

alter table public.wallets add constraint wallets_platform_wallet_has_no_user check (
  (kind in (
     'platform_revenue_topup_fees', 'platform_revenue_earnings_cut',
     'platform_reserve_topup_fees', 'platform_reserve_earnings_cut'
   ) and user_id is null) or
  (kind not in (
     'platform_revenue_topup_fees', 'platform_revenue_earnings_cut',
     'platform_reserve_topup_fees', 'platform_reserve_earnings_cut'
   ) and user_id is not null)
);

insert into public.wallets (user_id, kind, balance)
values
  (null, 'platform_reserve_topup_fees', 0),
  (null, 'platform_reserve_earnings_cut', 0);

alter table public.ledger_entries drop constraint ledger_entries_reason_check;

alter table public.ledger_entries add constraint ledger_entries_reason_check check (reason in (
  'topup_purchase',
  'topup_platform_fee',
  'message_debit',
  'escrow_hold',
  'escrow_release_earning',
  'escrow_release_platform_cut',
  'escrow_refund_unanswered',
  'earnings_conversion',
  'withdrawal_platform_fee',
  'withdrawal_payout',
  'withdrawal_refund_failed',
  'status_upload_debit',
  'manual_adjustment',
  'credit_transfer_sent',
  'credit_transfer_received',
  'credit_transfer_conversion',
  'credit_transfer_platform_cut',
  'group_message_debit',
  'group_message_owner_earning',
  'group_message_platform_cut',
  'platform_reserve_skim',
  'chargeback_debit',
  'chargeback_fee_reversal'
));

insert into public.pricing_config (key, value, description) values
  ('platform_reserve_bps', 400, 'Share of every platform-revenue credit (topup fees + earnings cut) held back into the rolling reserve wallets instead of the spendable revenue wallets, in basis points (400 = 4.00%) — docs/06-SECURITY-FRAUD-LOOPHOLES.md §3''s self-insurance buffer against chargeback/reversal losses')
on conflict (key) do nothing;

-- =============================================================================
-- fn_credit_platform_revenue — the one place platform revenue is split
-- between its spendable wallet and its reserve wallet. p_amount <= 0 is a
-- silent no-op (mirrors every other "if v_cut > 0" guard already used at
-- every call site in this codebase for a zero-cut edge case).
-- =============================================================================

create function public.fn_credit_platform_revenue(
  p_revenue_kind text,
  p_reserve_kind text,
  p_amount bigint,
  p_reason text,
  p_ref_type text,
  p_ref_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserve_bps bigint;
  v_reserve_cut bigint;
  v_net bigint;
  v_revenue_wallet_id uuid;
  v_reserve_wallet_id uuid;
begin
  if p_amount <= 0 then
    return;
  end if;

  select value into v_reserve_bps from pricing_config where key = 'platform_reserve_bps';

  select id into v_revenue_wallet_id from wallets
    where kind = p_revenue_kind and user_id is null
    for update;
  select id into v_reserve_wallet_id from wallets
    where kind = p_reserve_kind and user_id is null
    for update;

  v_reserve_cut := round(p_amount::numeric * v_reserve_bps / 10000)::bigint;
  v_net := p_amount - v_reserve_cut;

  if v_net > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_revenue_wallet_id, v_net, p_reason, p_ref_type, p_ref_id);
  end if;

  if v_reserve_cut > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_reserve_wallet_id, v_reserve_cut, 'platform_reserve_skim', p_ref_type, p_ref_id);
  end if;
end;
$$;

-- =============================================================================
-- fn_confirm_topup — unchanged except the platform-fee credit now goes
-- through fn_credit_platform_revenue. Full body restated per this project's
-- forward-migration convention (create or replace redefines the whole
-- function).
-- =============================================================================

create or replace function public.fn_confirm_topup(p_topup_id uuid, p_provider_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_topup topups%rowtype;
  v_wallet_id uuid;
  v_wallet_frozen boolean;
begin
  select * into v_topup from topups where id = p_topup_id for update;
  if not found then
    raise exception 'topup_not_found';
  end if;

  if v_topup.status = 'completed' then
    return;
  end if;

  if v_topup.status <> 'pending' then
    raise exception 'topup_not_pending: current status is %', v_topup.status;
  end if;

  select id, is_frozen into v_wallet_id, v_wallet_frozen from wallets
    where user_id = v_topup.user_id and kind = 'topup_credit'
    for update;

  if v_wallet_frozen then
    raise exception 'wallet_frozen';
  end if;

  update topups set status = 'completed', provider_ref = p_provider_ref where id = p_topup_id;

  if v_topup.credits_issued > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_wallet_id, v_topup.credits_issued, 'topup_purchase', 'topup', p_topup_id);
  end if;

  perform fn_credit_platform_revenue(
    'platform_revenue_topup_fees', 'platform_reserve_topup_fees',
    v_topup.platform_fee_kobo, 'topup_platform_fee', 'topup', p_topup_id
  );
end;
$$;

-- =============================================================================
-- fn_release_escrow — same change: the platform-cut credit now goes through
-- fn_credit_platform_revenue instead of a direct insert. The pre-loop
-- platform-wallet lock is dropped since the helper does its own locking
-- (same order every call: revenue wallet, then reserve wallet), and nothing
-- else in this function reads v_platform_wallet_id.
-- =============================================================================

create or replace function public.fn_release_escrow(p_thread_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread threads%rowtype;
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_earnings_pending_wallet_id uuid;
  v_earnings_pending_frozen boolean;
  v_withdrawable_cash_wallet_id uuid;
  v_withdrawable_cash_frozen boolean;
  v_escrow record;
  v_platform_cut bigint;
  v_payee_amount bigint;
  v_released_count integer := 0;
  v_per_minute_cap bigint;
  v_per_hour_cap bigint;
  v_similarity_threshold_bps bigint;
  v_lookback_n bigint;
  v_thread_release_count_1m bigint;
  v_payee_release_count_1h bigint;
  v_message_body text;
  v_message_sender_id uuid;
  v_recent_body text;
  v_is_duplicate boolean;
begin
  select * into v_thread from threads where id = p_thread_id;
  if not found then
    raise exception 'thread_not_found';
  end if;

  select value into v_take_bps from pricing_config where key = 'platform_earning_take_bps';
  select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';
  select value into v_per_minute_cap from pricing_config where key = 'escrow_release_messages_per_minute_cap';
  select value into v_per_hour_cap from pricing_config where key = 'escrow_release_earnings_per_hour_cap';
  select value into v_similarity_threshold_bps from pricing_config where key = 'duplicate_content_similarity_threshold_bps';
  select value into v_lookback_n from pricing_config where key = 'duplicate_content_lookback_messages';

  select id, is_frozen into v_earnings_pending_wallet_id, v_earnings_pending_frozen from wallets
    where user_id = v_thread.participant_b and kind = 'earnings_pending'
    for update;

  select id, is_frozen into v_withdrawable_cash_wallet_id, v_withdrawable_cash_frozen from wallets
    where user_id = v_thread.participant_b and kind = 'withdrawable_cash'
    for update;

  if v_earnings_pending_frozen or v_withdrawable_cash_frozen then
    raise exception 'wallet_frozen';
  end if;

  select count(*) into v_thread_release_count_1m from escrows
    where thread_id = p_thread_id and status = 'released' and created_at > now() - interval '1 minute';

  select count(*) into v_payee_release_count_1h from escrows
    where payee_id = v_thread.participant_b and status = 'released' and created_at > now() - interval '1 hour';

  for v_escrow in
    select * from escrows
    where thread_id = p_thread_id and status = 'pending'
    order by created_at
    for update
  loop
    if v_thread_release_count_1m >= v_per_minute_cap or v_payee_release_count_1h >= v_per_hour_cap then
      continue;
    end if;

    select body, sender_id into v_message_body, v_message_sender_id
      from messages where id = v_escrow.message_id;

    v_is_duplicate := false;
    if v_message_sender_id = v_thread.participant_b then
      for v_recent_body in
        select body from messages
        where sender_id = v_thread.participant_b and id <> v_escrow.message_id
        order by created_at desc
        limit v_lookback_n
      loop
        if similarity(v_message_body, v_recent_body) >= (v_similarity_threshold_bps::numeric / 10000) then
          v_is_duplicate := true;
          exit;
        end if;
      end loop;
    end if;

    if v_is_duplicate then
      if not exists (
        select 1 from fraud_signals
        where user_id = v_thread.participant_b
          and signal_type = 'duplicate_content'
          and created_at > now() - interval '1 hour'
      ) then
        insert into fraud_signals (user_id, signal_type, severity, metadata)
        values (
          v_thread.participant_b, 'duplicate_content', 'medium',
          jsonb_build_object('thread_id', p_thread_id, 'message_id', v_escrow.message_id)
        );
      end if;
      continue;
    end if;

    v_platform_cut := round(v_escrow.credits_held::numeric * v_take_bps / 10000)::bigint;
    v_payee_amount := v_escrow.credits_held - v_platform_cut;

    if v_payee_amount > 0 then
      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_earnings_pending_wallet_id, v_payee_amount, 'escrow_release_earning', 'escrow', v_escrow.id);

      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_earnings_pending_wallet_id, -v_payee_amount, 'earnings_conversion', 'escrow', v_escrow.id);

      insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
      values (v_withdrawable_cash_wallet_id, v_payee_amount * v_unit_kobo, 'earnings_conversion', 'escrow', v_escrow.id);
    end if;

    perform fn_credit_platform_revenue(
      'platform_revenue_earnings_cut', 'platform_reserve_earnings_cut',
      v_platform_cut, 'escrow_release_platform_cut', 'escrow', v_escrow.id
    );

    update escrows set status = 'released' where id = v_escrow.id;
    update messages set status = 'released' where id = v_escrow.message_id;

    v_released_count := v_released_count + 1;
    v_thread_release_count_1m := v_thread_release_count_1m + 1;
    v_payee_release_count_1h := v_payee_release_count_1h + 1;
  end loop;

  return v_released_count;
end;
$$;

-- =============================================================================
-- fn_transfer_credit — same change. v_platform_wallet_id stays in the
-- pre-sorted lock-order array (unlike fn_release_escrow, this function
-- already locks multiple wallets in a fixed sorted order specifically to
-- avoid cross-transfer deadlocks — removing it from that array would be a
-- real regression, not a cleanup). The helper's own internal lock of the
-- same wallet is redundant but harmless: the same transaction already
-- holds it.
-- =============================================================================

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

  perform fn_credit_platform_revenue(
    'platform_revenue_earnings_cut', 'platform_reserve_earnings_cut',
    v_platform_cut, 'credit_transfer_platform_cut', 'credit_transfer', v_transfer_id
  );

  return v_transfer_id;
end;
$$;

-- =============================================================================
-- fn_send_group_message — same change, for consistency with every other
-- revenue-crediting site (this function itself stays kill-switched off via
-- 'group_chat_enabled', per 20260913200000_group_chats.sql — this is not a
-- live behavior change, just keeping the one remaining direct
-- platform-revenue insert from drifting out of sync with the rest).
-- =============================================================================

create or replace function public.fn_send_group_message(
  p_group_thread_id uuid,
  p_sender_id uuid,
  p_body text
)
returns table (
  message_id uuid,
  credits_charged bigint,
  word_count integer,
  owner_earning_credits bigint,
  platform_take_credits bigint,
  payer_balance_after bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled bigint;
  v_group public.group_threads%rowtype;
  v_is_owner_post boolean;
  v_word_count integer;
  v_block_size bigint;
  v_base_credits bigint;
  v_max_words bigint;
  v_take_bps bigint;
  v_unit_kobo bigint;
  v_credits bigint;
  v_owner_earning bigint := 0;
  v_platform_take bigint := 0;
  v_sender_wallet_id uuid;
  v_owner_earnings_wallet_id uuid;
  v_owner_cash_wallet_id uuid;
  v_platform_wallet_id uuid;
  v_wallet_ids uuid[];
  v_wallet_id uuid;
  v_sender_balance bigint;
  v_sender_frozen boolean;
  v_owner_earnings_frozen boolean;
  v_owner_cash_frozen boolean;
  v_message_id uuid;
begin
  select value into v_enabled from pricing_config where key = 'group_chat_enabled';
  if coalesce(v_enabled, 0) = 0 then
    raise exception 'group_chat_disabled';
  end if;

  select * into v_group from group_threads where id = p_group_thread_id for update;
  if not found then
    raise exception 'group_not_found';
  end if;

  if not exists (
    select 1 from group_members
    where group_thread_id = p_group_thread_id and user_id = p_sender_id
  ) then
    raise exception 'not_a_member';
  end if;

  v_is_owner_post := (p_sender_id = v_group.created_by);

  v_word_count := coalesce(array_length(regexp_split_to_array(trim(both from p_body), '\s+'), 1), 0);
  if length(trim(both from p_body)) = 0 then
    v_word_count := 0;
  end if;
  if v_word_count < 1 then
    raise exception 'empty_message';
  end if;

  select value into v_block_size from pricing_config where key = 'message_word_block_size';
  select value into v_base_credits from pricing_config where key = 'message_base_credits';
  select value into v_max_words from pricing_config where key = 'message_max_words';

  if v_word_count > v_max_words then
    raise exception 'message_too_long: % words exceeds max of %', v_word_count, v_max_words;
  end if;

  v_credits := (v_base_credits * greatest(ceil(v_word_count::numeric / v_block_size), 1))::bigint;

  select id into v_sender_wallet_id from wallets
    where user_id = p_sender_id and kind = 'topup_credit';

  if not v_is_owner_post then
    select value into v_take_bps from pricing_config where key = 'platform_group_message_take_bps';
    select value into v_unit_kobo from pricing_config where key = 'credit_unit_kobo';

    select id into v_owner_earnings_wallet_id from wallets
      where user_id = v_group.created_by and kind = 'earnings_pending';
    select id into v_owner_cash_wallet_id from wallets
      where user_id = v_group.created_by and kind = 'withdrawable_cash';
    select id into v_platform_wallet_id from wallets
      where kind = 'platform_revenue_earnings_cut' and user_id is null;

    v_wallet_ids := array(
      select unnest(array[
        v_sender_wallet_id, v_owner_earnings_wallet_id, v_owner_cash_wallet_id, v_platform_wallet_id
      ]) order by 1
    );
  else
    v_wallet_ids := array[v_sender_wallet_id];
  end if;

  foreach v_wallet_id in array v_wallet_ids loop
    perform 1 from wallets where id = v_wallet_id for update;
  end loop;

  select balance, is_frozen into v_sender_balance, v_sender_frozen
    from wallets where id = v_sender_wallet_id;

  if v_sender_frozen then
    raise exception 'wallet_frozen';
  end if;

  if not v_is_owner_post then
    select is_frozen into v_owner_earnings_frozen from wallets where id = v_owner_earnings_wallet_id;
    select is_frozen into v_owner_cash_frozen from wallets where id = v_owner_cash_wallet_id;
    if v_owner_earnings_frozen or v_owner_cash_frozen then
      raise exception 'wallet_frozen';
    end if;
  end if;

  if v_sender_balance < v_credits then
    raise exception 'insufficient_credit: need % have %', v_credits, v_sender_balance;
  end if;

  if not v_is_owner_post then
    v_platform_take := round(v_credits::numeric * v_take_bps / 10000)::bigint;
    v_owner_earning := v_credits - v_platform_take;
  end if;

  insert into group_messages (
    group_thread_id, sender_id, body, word_count, credits_charged,
    owner_earning_credits, platform_take_credits
  )
  values (
    p_group_thread_id, p_sender_id, p_body, v_word_count, v_credits,
    v_owner_earning, v_platform_take
  )
  returning id into v_message_id;

  insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
  values (v_sender_wallet_id, -v_credits, 'group_message_debit', 'group_message', v_message_id);

  if v_owner_earning > 0 then
    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_owner_earnings_wallet_id, v_owner_earning, 'group_message_owner_earning', 'group_message', v_message_id);

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_owner_earnings_wallet_id, -v_owner_earning, 'earnings_conversion', 'group_message', v_message_id);

    insert into ledger_entries (wallet_id, amount, reason, ref_type, ref_id)
    values (v_owner_cash_wallet_id, v_owner_earning * v_unit_kobo, 'earnings_conversion', 'group_message', v_message_id);
  end if;

  perform fn_credit_platform_revenue(
    'platform_revenue_earnings_cut', 'platform_reserve_earnings_cut',
    v_platform_take, 'group_message_platform_cut', 'group_message', v_message_id
  );

  update group_threads set last_message_at = now() where id = p_group_thread_id;

  select balance into v_sender_balance from wallets where id = v_sender_wallet_id;

  return query select
    v_message_id, v_credits, v_word_count, v_owner_earning, v_platform_take, v_sender_balance;
end;
$$;
