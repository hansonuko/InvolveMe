-- No-bank-account withdrawal reminder (docs/06-SECURITY-FRAUD-LOOPHOLES.md §5:
-- "fire escalating reminders (push at 24h, 48h, 72h)" — the "hold" half of
-- that already existed (fn_run_auto_withdraw_sweep's inner join to a
-- name-match-verified bank_accounts row silently excludes anyone without
-- one from the sweep, per CLAUDE.md rule #7's "hold and notify, never skip
-- verification"); the "notify" half was named in that doc and in docs/05's
-- own scheduled-jobs table (inaccurately, as it turned out — that table
-- claimed auto-withdraw-sweep itself sends this reminder, which it never
-- did; corrected alongside this migration) but never actually built until
-- now. docs/10-UX-REFINEMENT-BACKLOG.md Batch G part 3.
--
-- The in-app half of §5's "push + persistent banner" pair already exists:
-- wallet.tsx's "Add bank account" action is always visible whenever the
-- user has no linked account (see LinkBankAccountModal) — no new banner
-- component needed, just the push side.
--
-- withdrawal_reminder_last_milestone_hours tracks the highest of {24, 48,
-- 72} already notified, not a plain "last sent at" timestamp: docs/06 §5
-- specifies three escalating pushes, not an indefinite repeat, so the new
-- remind-no-bank-account Edge Function only fires the next milestone once
-- the wallet's age (same `updated_at` aging concept fn_run_auto_withdraw_sweep
-- already uses) has actually passed it, and never re-fires one already sent.
--
-- No new SECURITY DEFINER function: candidate selection is a plain read
-- across wallets/bank_accounts/users tables the Edge Function's
-- service-role client already bypasses RLS for, same "query directly, no
-- function needed" posture reconcile-topups established for its own
-- candidate query. Writing withdrawal_reminder_last_milestone_hours is
-- likewise a plain service-role write — no client grant added, matching
-- kyc_tier/is_suspended's service-role-only posture.

alter table public.users
  add column withdrawal_reminder_last_milestone_hours smallint not null default 0;

select cron.schedule(
  'remind-no-bank-account',
  '0 */6 * * *', -- every 6 hours; fine-grained enough to catch each 24h/48h/72h milestone within a few hours of crossing it
  $$
  select net.http_post(
    url := 'https://ekotjsmgfluufsoralmf.supabase.co/functions/v1/remind-no-bank-account',
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
