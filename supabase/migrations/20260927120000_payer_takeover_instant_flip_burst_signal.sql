-- Payer takeover: remove the 24h idle-conversation block on claiming/
-- taking over the payer role (docs/18 §C1's own fraud angle, revisited).
--
-- Real-world report: a user tried to take over paying for a conversation
-- mid-emergency and was told "this conversation needs to be quiet for a
-- while before you can take over paying" — exactly the outcome docs/18
-- §C1's own idle-gate design did not intend to produce. The gate was
-- built as a wash-trading countermeasure (two colluding accounts
-- alternating who "earns"), not as friction on a genuine, willing payer.
-- A person who wants to pay for their own conversation, right now, for
-- any reason, must never be blocked from doing so — that's the standing
-- rule this migration restores.
--
-- fn_send_message was never actually the problem: it only ever blocks a
-- send when `payer_id is null` (nobody has claimed the role at all), and
-- that's still correct and unchanged here — every message needs someone
-- who has agreed to pay for it. The idle gate lived entirely in
-- fn_set_thread_payer's *claim* path, and only there, so removing it
-- doesn't touch billing at all.
--
-- The fraud concern docs/18 §C1 raised is real (internal credit velocity
-- between two colluding accounts), so it isn't dropped — it moves from a
-- user-facing block to the same additive, non-blocking
-- fraud_signals/fn_run_collusion_detection pipeline every other fraud
-- heuristic in this codebase already uses (docs/06 §2). docs/18 §C1 line
-- 110 scoped exactly this signal ("watch for a payer takeover landing
-- right at the idle-threshold boundary followed by a burst of messages")
-- but never built it, deferring to the gate instead — this is that signal,
-- built now that the gate it was meant to complement is gone. Ops reviews
-- fraud_signals directly in Supabase Studio, same posture as every other
-- signal type; nobody's money or ability to message is ever touched by it.

-- =============================================================================
-- fn_set_thread_payer — idle gate removed. Self-only appointment and
-- current-payer-only stepdown are unchanged; claiming (from an active
-- payer OR from null) is now instant, same as stepping down always was.
-- =============================================================================

create or replace function public.fn_set_thread_payer(p_thread_id uuid, p_caller_id uuid, p_new_payer_id uuid)
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

  if p_new_payer_id is not null and p_new_payer_id <> p_caller_id then
    raise exception 'can_only_appoint_self';
  end if;

  if p_new_payer_id is null then
    -- Stepping down: only the current payer may do this, any time.
    if v_thread.payer_id is distinct from p_caller_id then
      raise exception 'not_current_payer';
    end if;
  elsif v_thread.payer_id = p_caller_id then
    -- Already the payer — idempotent no-op, not an error.
    return;
  end if;
  -- Claiming/taking over (from the other participant's active role, or out
  -- of null) is instant and ungated, exactly like stepping down — a
  -- willing payer is never made to wait. The wash-trading risk this used
  -- to gate against is now watched for, not blocked, by
  -- fn_run_collusion_detection's payer_flip_then_burst signal below.

  insert into thread_payer_history (thread_id, changed_by, old_payer_id, new_payer_id)
  values (p_thread_id, p_caller_id, v_thread.payer_id, p_new_payer_id);

  update threads set payer_id = p_new_payer_id where id = p_thread_id;
end;
$$;

revoke execute on function public.fn_set_thread_payer(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_set_thread_payer(uuid, uuid, uuid) to service_role;

-- =============================================================================
-- pricing_config: `thread_payer_min_idle_hours` is repurposed from a
-- blocking gate threshold into a detection threshold — how idle a thread
-- must have been right before a payer flip for the flip to be considered
-- "at the boundary" and worth watching for a following message burst.
-- Same key, same value (24h), so no data migration needed; description
-- updated to describe what it actually gates now. Two new keys size the
-- burst half of the signal.
-- =============================================================================

update public.pricing_config
set description = 'How idle a thread must have been immediately before a payer-role flip for fn_run_collusion_detection''s payer_flip_then_burst signal to consider that flip "at the idle boundary" (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §C1). No longer blocks the flip itself — see 20260927120000_payer_takeover_instant_flip_burst_signal.sql for why a willing payer is never made to wait — this is detection-only now.'
where key = 'thread_payer_min_idle_hours' and currency = 'NGN';

insert into public.pricing_config (key, currency, value, description) values
  ('payer_flip_burst_min_messages', 'NGN', 5,
   'Minimum paid messages the new payer must send within payer_flip_burst_window_hours of an idle-boundary payer-role flip before fn_run_collusion_detection''s payer_flip_then_burst signal fires (docs/18 §C1).'),
  ('payer_flip_burst_window_hours', 'NGN', 1,
   'Window after an idle-boundary payer-role flip in which a burst of paid messages from the new payer is considered suspicious (docs/18 §C1''s "flip-then-burst" pattern).')
on conflict (key, currency) do nothing;

-- =============================================================================
-- fn_run_collusion_detection — adds Signal C: payer_flip_then_burst.
-- Signals A and B (shared-fingerprint, concentrated-pairing) are
-- byte-for-byte unchanged from 20260915095500_fix_collusion_detection_min_
-- uuid.sql (the live definition — NOT the original 20260915093000 one,
-- which has a real bug that migration fixed: `min(uuid)` doesn't exist as
-- a Postgres aggregate; caught here by actually running this migration's
-- own new test against the dev DB, the same way the original bug was
-- caught — see that migration's own header for the fix's reasoning).
-- Only the new block and its three new declared variables are added.
-- =============================================================================

create or replace function public.fn_run_collusion_detection()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_shared_fp_messages bigint;
  v_concentration_share_bps bigint;
  v_concentration_min_messages bigint;
  v_flip_idle_hours bigint;
  v_flip_burst_min_messages bigint;
  v_flip_burst_window_hours bigint;
  v_signal_count integer := 0;
  v_batch_count integer;
begin
  select value into v_min_shared_fp_messages from pricing_config where key = 'collusion_shared_fingerprint_min_messages';
  select value into v_concentration_share_bps from pricing_config where key = 'collusion_concentration_share_bps';
  select value into v_concentration_min_messages from pricing_config where key = 'collusion_concentration_min_messages';
  select value into v_flip_idle_hours from pricing_config where key = 'thread_payer_min_idle_hours' and currency = 'NGN';
  select value into v_flip_burst_min_messages from pricing_config where key = 'payer_flip_burst_min_messages' and currency = 'NGN';
  select value into v_flip_burst_window_hours from pricing_config where key = 'payer_flip_burst_window_hours' and currency = 'NGN';

  -- Signal A: two accounts sharing a device fingerprint, with real paid
  -- (escrow-backed) activity between them — the direct §2 exploit shape.
  with shared_fp_pairs as (
    select a.id as user_a, b.id as user_b, fp.fingerprint_id
    from users a
    cross join lateral unnest(a.device_fingerprint_ids) as fp(fingerprint_id)
    join users b on b.id > a.id and fp.fingerprint_id = any(b.device_fingerprint_ids)
  ),
  candidates as (
    select p.user_a, p.user_b,
      (array_agg(p.fingerprint_id order by p.fingerprint_id))[1] as shared_fingerprint_id,
      count(e.id) as message_count
    from shared_fp_pairs p
    join escrows e
      on (e.payer_id = p.user_a and e.payee_id = p.user_b)
      or (e.payer_id = p.user_b and e.payee_id = p.user_a)
    group by p.user_a, p.user_b
    having count(e.id) >= v_min_shared_fp_messages
  )
  insert into fraud_signals (user_id, related_user_id, signal_type, severity, metadata)
  select c.user_a, c.user_b, 'shared_device_fingerprint', 'high',
    jsonb_build_object('shared_fingerprint_id', c.shared_fingerprint_id, 'message_count', c.message_count)
  from candidates c
  where not exists (
    select 1 from fraud_signals fs
    where fs.signal_type = 'shared_device_fingerprint'
      and ((fs.user_id = c.user_a and fs.related_user_id = c.user_b)
        or (fs.user_id = c.user_b and fs.related_user_id = c.user_a))
  );
  get diagnostics v_batch_count = row_count;
  v_signal_count := v_signal_count + v_batch_count;

  -- Signal B: one payee dominating a payer's paid-message volume over a
  -- rolling week — the "narrow, dense" graph pattern from §2, approximated
  -- as a simple share-of-volume heuristic rather than a real graph
  -- algorithm (deliberately — matches this project's "stay lite" bias,
  -- and stays fully explainable to whoever reviews it in Supabase Studio).
  with pair_counts as (
    select payer_id, payee_id, count(*) as pair_count,
      sum(count(*)) over (partition by payer_id) as payer_total
    from escrows
    where created_at > now() - interval '7 days'
    group by payer_id, payee_id
  ),
  candidates as (
    select payer_id, payee_id, pair_count, payer_total,
      round(pair_count::numeric / nullif(payer_total, 0) * 10000) as share_bps
    from pair_counts
    where pair_count >= v_concentration_min_messages
  )
  insert into fraud_signals (user_id, related_user_id, signal_type, severity, metadata)
  select c.payer_id, c.payee_id, 'concentrated_pairing', 'medium',
    jsonb_build_object(
      'pair_message_count', c.pair_count,
      'payer_total_messages_7d', c.payer_total,
      'share_bps', c.share_bps
    )
  from candidates c
  where c.share_bps >= v_concentration_share_bps
    and not exists (
      select 1 from fraud_signals fs
      where fs.signal_type = 'concentrated_pairing'
        and ((fs.user_id = c.payer_id and fs.related_user_id = c.payee_id)
          or (fs.user_id = c.payee_id and fs.related_user_id = c.payer_id))
        and fs.created_at > now() - interval '7 days'
    );
  get diagnostics v_batch_count = row_count;
  v_signal_count := v_signal_count + v_batch_count;

  -- Signal C: payer_flip_then_burst (docs/18 §C1, this migration's own
  -- header). A payer-role claim/takeover that landed while the thread was
  -- at least v_flip_idle_hours idle, immediately followed by at least
  -- v_flip_burst_min_messages PAID (credits_charged > 0 — a free
  -- status-reply doesn't count) messages from the new payer within
  -- v_flip_burst_window_hours. Deduped per exact flip event (thread +
  -- changed_at), so a re-run of this nightly job never double-flags the
  -- same flip, but a later, separate flip on the same pair is flagged
  -- again — same "behavioral pattern can recur" posture Signal B uses.
  with flips as (
    select tph.id as flip_id, tph.thread_id, tph.new_payer_id, tph.changed_at,
      (
        select max(m.created_at) from messages m
        where m.thread_id = tph.thread_id and m.created_at < tph.changed_at
      ) as last_message_before_flip
    from thread_payer_history tph
    where tph.new_payer_id is not null
      and tph.changed_at > now() - interval '7 days'
  ),
  idle_flips as (
    select * from flips
    where last_message_before_flip is null
      or changed_at - last_message_before_flip >= make_interval(hours => v_flip_idle_hours::integer)
  ),
  bursts as (
    select f.flip_id, f.thread_id, f.new_payer_id, f.changed_at, count(m.id) as burst_count
    from idle_flips f
    join messages m
      on m.thread_id = f.thread_id
      and m.sender_id = f.new_payer_id
      and m.credits_charged > 0
      and m.created_at > f.changed_at
      and m.created_at <= f.changed_at + make_interval(hours => v_flip_burst_window_hours::integer)
    group by f.flip_id, f.thread_id, f.new_payer_id, f.changed_at
    having count(m.id) >= v_flip_burst_min_messages
  ),
  candidates as (
    select b.thread_id, b.new_payer_id as flipper,
      case when t.participant_a = b.new_payer_id then t.participant_b else t.participant_a end as other_party,
      b.burst_count, b.changed_at
    from bursts b
    join threads t on t.id = b.thread_id
  )
  insert into fraud_signals (user_id, related_user_id, signal_type, severity, metadata)
  select c.flipper, c.other_party, 'payer_flip_then_burst', 'medium',
    jsonb_build_object(
      'thread_id', c.thread_id,
      'burst_message_count', c.burst_count,
      'flip_at', c.changed_at
    )
  from candidates c
  where not exists (
    select 1 from fraud_signals fs
    where fs.signal_type = 'payer_flip_then_burst'
      and fs.user_id = c.flipper
      and fs.related_user_id = c.other_party
      and (fs.metadata->>'thread_id')::uuid = c.thread_id
      and (fs.metadata->>'flip_at')::timestamptz = c.changed_at
  );
  get diagnostics v_batch_count = row_count;
  v_signal_count := v_signal_count + v_batch_count;

  return v_signal_count;
end;
$$;

revoke execute on function public.fn_run_collusion_detection() from public, anon, authenticated;
grant execute on function public.fn_run_collusion_detection() to service_role;
