-- Statuses are supposed to disappear 24h after posting, for the poster too
-- — same as WhatsApp. `status_updates_select_own` (20260912072749_rls_
-- policies.sql) never actually enforced that: it only checked
-- `user_id = auth.uid()`, so a poster's own expired statuses stayed
-- visible forever, only the OTHER, later-added policy
-- (status_updates_select_visible_to_thread_partner,
-- 20260916090000_status_visibility_and_view_tracking.sql) ever gated on
-- `expires_at`, and that one only applies to viewers, not the poster. Real
-- bug, not a hypothetical: confirmed by reading that policy's own migration
-- comment, which documents the "stays visible after expiry" behavior as
-- deliberate at the time. Product direction now is the opposite — expired
-- means gone, symmetrically, for both sides.
--
-- `alter policy`, not drop+recreate — same predicate, tighter condition,
-- no reason to touch the `to authenticated` clause or policy name any
-- client code already depends on.
alter policy status_updates_select_own on public.status_updates
  using (user_id = auth.uid() and expires_at > now());

-- =============================================================================
-- The RLS change above makes an expired status invisible immediately, for
-- every reader — but the row (and its Storage object, if any) still sits
-- there forever with nothing to ever clean it up. `expire-statuses` (new
-- Edge Function) does that actual deletion, including the Storage object
-- (something no plain SQL/plpgsql function can do — Storage's real backend
-- isn't reachable from inside Postgres, only through the Storage API,
-- hence an Edge Function rather than a plpgsql sweep function like this
-- app's other three cron jobs). Same pg_net + X-Cron-Secret shape as
-- reconcile-topups (20260914120000_reconcile_topups_cron.sql) — reusing
-- that same CRON_INTERNAL_SECRET vault entry/function secret, a generic
-- "this call came from this project's own cron," not topup-specific.
--
-- Every 15 minutes, matching escrow-expiry-sweep's own cadence
-- (20260912081331_wire_scheduled_jobs.sql) — statuses expiring is a
-- routine, high-frequency event (every status, every 24h), not a rare
-- fixup, so it warrants the same tight interval rather than the hourly one
-- used for the auto-withdraw/reconciliation jobs.
select cron.schedule(
  'status-expiry-sweep',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://ekotjsmgfluufsoralmf.supabase.co/functions/v1/expire-statuses',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cron-Secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'cron_internal_secret'),
        ''
      )
    ),
    body := '{}'::jsonb
  );
  $$
);
