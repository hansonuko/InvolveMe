-- Phase 5 fraud infra, part 3 (docs/06-SECURITY-FRAUD-LOOPHOLES.md §2 —
-- self-dealing / wash-chatting, "the big one"). Two signal types, both
-- purely additive to `fraud_signals` — per explicit product decision this
-- session, this job NEVER sets `is_frozen` itself. This app has no admin
-- UI (ops reviews fraud_signals directly in Supabase Studio); a
-- false-positive auto-freeze on a real user's money, with no self-serve
-- unfreeze path, is a worse outcome than a slower manual review. Every
-- `is_frozen` check across the codebase (fn_send_message,
-- fn_confirm_topup, fn_initiate_withdrawal, fn_release_escrow,
-- fn_transfer_credit) already exists and already works — this job's only
-- job is to point a human at the right rows.

insert into public.pricing_config (key, value, description) values
  ('collusion_shared_fingerprint_min_messages', 1, 'Minimum paid messages between a pair sharing a device fingerprint before flagging (docs/06 §2) — deliberately low: shared hardware + any real money movement is already a strong signal on its own.'),
  ('collusion_concentration_share_bps', 8000, '"Concentrated pairing" threshold — a payee representing this share (basis points, 8000 = 80%) or more of a payer''s weekly paid-message volume gets flagged (docs/06 §2''s "narrow, dense" heuristic).'),
  ('collusion_concentration_min_messages', 20, 'Floor on pair message count before the concentration share matters — avoids flagging two people who just had one intense day (docs/06 §2).')
on conflict (key) do nothing;

-- =============================================================================
-- fn_run_collusion_detection — nightly. Two independent, additive signal
-- types; a pair can trigger both. Idempotent: re-running the same night
-- (or the cron firing twice) never inserts a duplicate open signal for
-- the same pair/type — fraud_signals has no resolved/status column today
-- (a real limitation, not an oversight: adding proper signal-lifecycle
-- tracking is future work, not scoped here), so "already flagged" is
-- judged by existence (shared-fingerprint signals, permanent condition,
-- never re-flagged once seen) or a rolling window (concentrated-pairing,
-- re-flagged if it's still true a week after the last flag, since that's
-- a behavioral pattern that can start and stop).
-- =============================================================================

create function public.fn_run_collusion_detection()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_min_shared_fp_messages bigint;
  v_concentration_share_bps bigint;
  v_concentration_min_messages bigint;
  v_signal_count integer := 0;
  v_batch_count integer;
begin
  select value into v_min_shared_fp_messages from pricing_config where key = 'collusion_shared_fingerprint_min_messages';
  select value into v_concentration_share_bps from pricing_config where key = 'collusion_concentration_share_bps';
  select value into v_concentration_min_messages from pricing_config where key = 'collusion_concentration_min_messages';

  -- Signal A: two accounts sharing a device fingerprint, with real paid
  -- (escrow-backed) activity between them — the direct §2 exploit shape.
  with shared_fp_pairs as (
    select a.id as user_a, b.id as user_b, fp.fingerprint_id
    from users a
    cross join lateral unnest(a.device_fingerprint_ids) as fp(fingerprint_id)
    join users b on b.id > a.id and fp.fingerprint_id = any(b.device_fingerprint_ids)
  ),
  candidates as (
    select p.user_a, p.user_b, min(p.fingerprint_id) as shared_fingerprint_id, count(e.id) as message_count
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

  return v_signal_count;
end;
$$;

revoke execute on function public.fn_run_collusion_detection() from public;
grant execute on function public.fn_run_collusion_detection() to service_role;

select cron.schedule(
  'collusion-detection',
  '0 3 * * *', -- nightly at 03:00 — off-peak, matches docs/06 §2's own "nightly job" framing
  $$ select public.fn_run_collusion_detection(); $$
);
