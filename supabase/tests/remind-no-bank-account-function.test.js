#!/usr/bin/env node
// Test for the remind-no-bank-account Edge Function
// (20260917120000_no_bank_account_reminder_cron.sql, docs/10-UX-REFINEMENT-BACKLOG.md
// Batch G part 3 / docs/06-SECURITY-FRAUD-LOOPHOLES.md §5's "notify" half).
// Same raw-insert `auth.users` fixture pattern fraud-functions.test.js uses
// for its own auto-sweep-adjacent fixtures — safe here because, like
// reconcile-topups, this function's auth is a shared X-Cron-Secret header,
// never a per-user JWT, so there's no GoTrue-validity requirement on the
// fixture user the way there is for get-withdrawal-countdown's tests.
//
// What this deliberately does NOT cover: actual push delivery (no real
// device token is registered for any fixture user, so sendPushToUser's own
// Expo API call silently no-ops — exactly the same "no push_tokens row"
// posture _shared/push.ts documents as its definition of "notifications
// off"). The observable, DB-level effect this suite checks instead is
// `users.withdrawal_reminder_last_milestone_hours`, which is exactly what
// the function updates immediately before firing that best-effort push.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_INTERNAL_SECRET || 'test-cron-secret';

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(
  __dirname,
  '..',
  'functions',
  'remind-no-bank-account',
  'index.ts',
);

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

async function callRemind({ secret } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Cron-Secret'] = secret !== undefined ? secret : CRON_SECRET;
  const res = await fetch(`${FUNCTION_URL}/`, { method: 'POST', headers, body: '{}' });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${FUNCTION_URL}/`, { method: 'POST', body: '{}' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('remind-no-bank-account function did not come up in time');
}

// Same raw-insert shortcut and rationale as fraud-functions.test.js's
// createAgedUser — this function never checks a per-user JWT.
async function createTestUser(admin) {
  const id = crypto.randomUUID();
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  await admin.query(
    `insert into auth.users (id, phone, created_at, aud, role, instance_id)
     values ($1, $2, now(), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`,
    [id, phone],
  );
  return id;
}

// Mirrors fraud-functions.test.js's setupWithdrawableWallet, minus the
// always-verified bank account (verification is exactly what this suite
// varies) and with an explicit milestone starting point so tests can
// simulate "already notified once."
async function setupWallet(admin, userId, kobo, updatedHoursAgo, startingMilestone = 0) {
  const wallet = await admin.query(
    `select id from public.wallets where user_id = $1 and kind = 'withdrawable_cash'`,
    [userId],
  );
  const walletId = wallet.rows[0].id;
  if (kobo > 0) {
    await admin.query(
      `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
      [walletId, kobo],
    );
  }
  await admin.query(
    'update public.wallets set updated_at = now() - make_interval(hours => $2) where id = $1',
    [walletId, updatedHoursAgo],
  );
  await admin.query(
    'update public.users set withdrawal_reminder_last_milestone_hours = $2 where id = $1',
    [userId, startingMilestone],
  );
  return walletId;
}

async function addVerifiedBankAccount(admin, userId) {
  await admin.query(
    `insert into public.bank_accounts (user_id, bank_name, account_name, name_match_verified)
     values ($1, 'Test Bank', 'Reminder Test', true)`,
    [userId],
  );
}

async function getMilestone(admin, userId) {
  const res = await admin.query(
    'select withdrawal_reminder_last_milestone_hours from public.users where id = $1',
    [userId],
  );
  return res.rows[0]?.withdrawal_reminder_last_milestone_hours;
}

async function deleteTestUser(admin, id) {
  await admin.query('begin');
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('commit');
  await admin.query('delete from public.bank_accounts where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const deno = spawn('deno', ['run', '-A', FUNCTION_ENTRY], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      CRON_INTERNAL_SECRET: CRON_SECRET,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  let tooFresh, unverified24h, unverifiedJumpTo48, verifiedExcluded, alreadyAt72, zeroBalance;

  try {
    await waitForFunctionReady(15000);

    const noSecret = await callRemind({ secret: null });
    log('missing X-Cron-Secret -> 401', noSecret.status === 401, JSON.stringify(noSecret.json));

    const wrongSecret = await callRemind({ secret: 'definitely-not-it' });
    log('wrong X-Cron-Secret -> 401', wrongSecret.status === 401, JSON.stringify(wrongSecret.json));

    const getRes = await fetch(`${FUNCTION_URL}/`, {
      method: 'GET',
      headers: { 'X-Cron-Secret': CRON_SECRET },
    });
    log('GET -> 405', getRes.status === 405);

    // Aged only 10h — younger than the 24h minimum sweep-eligible age, so
    // it's excluded from candidacy entirely, no bank account or not.
    tooFresh = await createTestUser(admin);
    await setupWallet(admin, tooFresh, 50000, 10);

    // Aged 25h, no bank account -> due its first milestone (24h).
    unverified24h = await createTestUser(admin);
    await setupWallet(admin, unverified24h, 50000, 25);

    // Aged 50h, no bank account, never notified -> jumps straight to 48h
    // (skips 24h — matches the function's own "highest first" comment: a
    // wallet that aged past a milestone before ever being checked gets
    // only the highest one due, not a backlog of all of them).
    unverifiedJumpTo48 = await createTestUser(admin);
    await setupWallet(admin, unverifiedJumpTo48, 50000, 50);

    // Aged 80h (past all three milestones) but WITH a verified bank
    // account -> excluded entirely, same as auto-sweep's own inner join.
    verifiedExcluded = await createTestUser(admin);
    await setupWallet(admin, verifiedExcluded, 50000, 80);
    await addVerifiedBankAccount(admin, verifiedExcluded);

    // Aged 80h, no bank account, already at the 72h milestone -> no further
    // milestone to fire (72 is the last one docs/06 §5 specifies).
    alreadyAt72 = await createTestUser(admin);
    await setupWallet(admin, alreadyAt72, 50000, 80, 72);

    // Aged 80h, no bank account, but a zero balance -> nothing to remind
    // about (the sweep itself only ever considers balance > 0 too).
    zeroBalance = await createTestUser(admin);
    await setupWallet(admin, zeroBalance, 0, 80);

    const result = await callRemind();
    log('remind call -> 200', result.status === 200, JSON.stringify(result.json));

    log('too-fresh wallet (10h old) is not reminded', (await getMilestone(admin, tooFresh)) === 0);
    log(
      'unverified wallet aged 25h gets the 24h milestone',
      (await getMilestone(admin, unverified24h)) === 24,
    );
    log(
      'unverified wallet aged 50h with no prior milestone jumps straight to 48h',
      (await getMilestone(admin, unverifiedJumpTo48)) === 48,
    );
    log(
      'wallet with a verified bank account is never reminded regardless of age',
      (await getMilestone(admin, verifiedExcluded)) === 0,
    );
    log(
      'wallet already at the 72h milestone does not re-fire',
      (await getMilestone(admin, alreadyAt72)) === 72,
    );
    log('zero-balance wallet is not reminded', (await getMilestone(admin, zeroBalance)) === 0);
  } finally {
    deno.kill();
    for (const id of [
      tooFresh,
      unverified24h,
      unverifiedJumpTo48,
      verifiedExcluded,
      alreadyAt72,
      zeroBalance,
    ]) {
      if (id) await deleteTestUser(admin, id);
    }
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
