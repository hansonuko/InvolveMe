-- Schedules the reconcile-topups Edge Function (docs/00-SESSION-HANDOFF.md
-- session 12). Ground truth this session, not another guess: Flutterwave
-- has never once successfully delivered a real webhook to
-- webhook-flutterwave, despite that function's contract now being verified
-- correct against 5 real charges. Two previous "permanent fixes" both
-- addressed real bugs in this codebase and neither closed the actual gap,
-- because the actual gap isn't in this codebase — it's that a webhook
-- delivery, for whatever reason (most likely a dashboard-side URL/secret
-- misconfiguration this app's code can't see), never leaves Flutterwave's
-- side. A pull-based check the app itself initiates doesn't depend on that
-- ever being fixed correctly, or fixed and staying fixed.
--
-- Unlike the existing three jobs in 20260912081331_wire_scheduled_jobs.sql,
-- this one needs a real HTTPS call to Flutterwave's API (OAuth token
-- exchange + a GET request) — genuinely external I/O, not something plain
-- SQL/plpgsql can reasonably do itself. That work already exists in
-- packages/payments/flutterwave.ts (checkCollectionStatus, added this
-- session) behind the same PaymentProvider interface every other payment
-- call in this app goes through (CLAUDE.md rule #5) — this migration's only
-- job is to make pg_cron invoke that Edge Function on a schedule via
-- pg_net, not to reimplement any of that logic in SQL.
--
-- CRON_INTERNAL_SECRET: deliberately NOT set by this migration — like every
-- other real secret in this project (FLW_CLIENT_SECRET, etc.), the actual
-- value is never committed to git. Provisioned out-of-band, once: `supabase
-- secrets set CRON_INTERNAL_SECRET=...` for the Edge Function side, and
-- `select vault.create_secret('<value>', 'cron_internal_secret', '...')`
-- for the DB side. Vault, not a plain `app.settings.*` GUC: tried that
-- first this session and it 42501'd — hosted Supabase's `postgres` role
-- isn't allowed to `alter database ... set` an arbitrary custom parameter,
-- only actual superuser can, which this project doesn't have on the
-- managed instance. `supabase_vault` (already installed on this project)
-- is Supabase's own answer to exactly this problem — encrypted at rest,
-- readable by the migration below via the `vault.decrypted_secrets` view,
-- and it's the documented pattern for this pg_cron-calls-an-Edge-Function
-- shape generally, not a workaround specific to this bug.

create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'reconcile-topups',
  '*/10 * * * *', -- every 10 minutes; MIN_AGE_MINUTES=5 in the function itself
                  -- already keeps this from racing a legitimately in-flight
                  -- payment or a webhook that's about to land normally.
  $$
  select net.http_post(
    url := 'https://ekotjsmgfluufsoralmf.supabase.co/functions/v1/reconcile-topups',
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
