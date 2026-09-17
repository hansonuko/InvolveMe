// POST /functions/v1/remind-no-bank-account
//
// Server-to-server only, triggered by pg_cron via pg_net every 6 hours (see
// migration 20260917120000_no_bank_account_reminder_cron.sql) — not called
// by the app. Same X-Cron-Secret auth posture as reconcile-topups, and for
// the same structural reason (pg_net has no clean way to attach a real
// Supabase-signed JWT without embedding the service role key in a
// git-committed migration).
//
// Closes docs/06-SECURITY-FRAUD-LOOPHOLES.md §5's "notify" half: auto-sweep
// (fn_run_auto_withdraw_sweep) already silently excludes any
// withdrawable_cash wallet with no bank_accounts row where
// name_match_verified = true — the money is held, never force-paid to an
// unverified destination (CLAUDE.md rule #7) — but nothing ever told the
// affected user why their money wasn't moving. This sends exactly the
// three escalating pushes §5 specifies (24h, 48h, 72h past the wallet's
// normal sweep-eligible age), never more, tracked via
// `users.withdrawal_reminder_last_milestone_hours`.
//
// The in-app half of §5 ("persistent banner") is already covered by
// wallet.tsx's always-visible "Add bank account" action whenever no
// account is linked — nothing new needed there.

import { timingSafeEqual } from 'node:crypto';
import { serviceRoleClient } from '../_shared/auth.ts';
import { runInBackground, sendPushToUser } from '../_shared/push.ts';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkCronSecret(req: Request): boolean {
  const expected = Deno.env.get('CRON_INTERNAL_SECRET') ?? '';
  const actual = req.headers.get('x-cron-secret') ?? '';
  if (!expected || !actual) return false;
  const expectedBuf = new TextEncoder().encode(expected);
  const actualBuf = new TextEncoder().encode(actual);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

// docs/06-SECURITY-FRAUD-LOOPHOLES.md §5, exactly — three escalating
// pushes, never more. Checked highest-first so a wallet that's aged past
// 72h without ever having been checked (e.g. this job was down a while)
// gets only the 72h copy, not a backlog of all three at once.
const MILESTONES_HOURS = [72, 48, 24] as const;

function milestoneMessage(hours: (typeof MILESTONES_HOURS)[number]): string {
  switch (hours) {
    case 24:
      return "You have cash waiting to be paid out, but there's no verified bank account on file yet — add one in Wallet to receive it.";
    case 48:
      return "Your withdrawable balance still can't be paid out — add a verified bank account in Wallet so it doesn't keep sitting there.";
    case 72:
      return "It's been 3 days — add a verified bank account in Wallet to finally receive your balance.";
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed', message: 'Use POST.' });
  }
  if (!checkCronSecret(req)) {
    return json(401, { error: 'unauthorized', message: 'Invalid or missing X-Cron-Secret.' });
  }

  const db = serviceRoleClient();

  const { data: sweepHoursRows, error: configError } = await db
    .from('pricing_config')
    .select('key, value')
    .in('key', ['withdrawal_auto_sweep_hours', 'withdrawal_auto_sweep_hours_untrusted']);

  if (configError) {
    console.error('remind-no-bank-account: pricing_config query failed:', configError.message);
    return json(500, { error: 'internal_error', message: 'Could not query pricing_config.' });
  }

  const sweepHoursByKey = new Map((sweepHoursRows ?? []).map((r) => [r.key, r.value as number]));
  const minSweepHours = Math.min(
    sweepHoursByKey.get('withdrawal_auto_sweep_hours') ?? 24,
    sweepHoursByKey.get('withdrawal_auto_sweep_hours_untrusted') ?? 72,
  );

  // Same aging gate fn_run_auto_withdraw_sweep's own candidate query uses —
  // only wallets old enough to have already been evaluated for a sweep are
  // worth reminding about at all.
  const cutoff = new Date(Date.now() - minSweepHours * 60 * 60 * 1000).toISOString();

  const { data: candidateWallets, error: walletsError } = await db
    .from('wallets')
    .select('user_id, updated_at')
    .eq('kind', 'withdrawable_cash')
    .gt('balance', 0)
    .eq('is_frozen', false)
    .lt('updated_at', cutoff);

  if (walletsError) {
    console.error('remind-no-bank-account: wallet query failed:', walletsError.message);
    return json(500, { error: 'internal_error', message: 'Could not query wallets.' });
  }
  if (!candidateWallets?.length) {
    return json(200, { checked: 0, reminded: 0 });
  }

  const candidateUserIds = candidateWallets.map((w) => w.user_id);

  const { data: verifiedAccounts, error: bankError } = await db
    .from('bank_accounts')
    .select('user_id')
    .eq('name_match_verified', true)
    .in('user_id', candidateUserIds);

  if (bankError) {
    console.error('remind-no-bank-account: bank_accounts query failed:', bankError.message);
    return json(500, { error: 'internal_error', message: 'Could not query bank_accounts.' });
  }

  const verifiedUserIds = new Set((verifiedAccounts ?? []).map((b) => b.user_id));
  const unverifiedWallets = candidateWallets.filter((w) => !verifiedUserIds.has(w.user_id));

  if (!unverifiedWallets.length) {
    return json(200, { checked: candidateWallets.length, reminded: 0 });
  }

  const { data: users, error: usersError } = await db
    .from('users')
    .select('id, withdrawal_reminder_last_milestone_hours')
    .in(
      'id',
      unverifiedWallets.map((w) => w.user_id),
    );

  if (usersError) {
    console.error('remind-no-bank-account: users query failed:', usersError.message);
    return json(500, { error: 'internal_error', message: 'Could not query users.' });
  }

  const lastMilestoneByUserId = new Map(
    (users ?? []).map((u) => [u.id, u.withdrawal_reminder_last_milestone_hours as number]),
  );

  let reminded = 0;
  for (const wallet of unverifiedWallets) {
    const ageHours = (Date.now() - new Date(wallet.updated_at).getTime()) / (60 * 60 * 1000);
    const lastMilestone = lastMilestoneByUserId.get(wallet.user_id) ?? 0;

    const dueMilestone = MILESTONES_HOURS.find(
      (hours) => ageHours >= hours && hours > lastMilestone,
    );
    if (!dueMilestone) continue;

    const { error: updateError } = await db
      .from('users')
      .update({ withdrawal_reminder_last_milestone_hours: dueMilestone })
      .eq('id', wallet.user_id);

    if (updateError) {
      console.error(
        `remind-no-bank-account: failed to update milestone for ${wallet.user_id}:`,
        updateError.message,
      );
      continue;
    }

    reminded++;
    runInBackground(() =>
      sendPushToUser(
        db,
        wallet.user_id,
        'Add a bank account to get paid',
        milestoneMessage(dueMilestone),
        { type: 'no_bank_account_reminder', milestone_hours: dueMilestone },
      ),
    );
  }

  return json(200, { checked: candidateWallets.length, reminded });
});
