#!/usr/bin/env node
// Test for the reconcile-topups Edge Function (docs/00-SESSION-HANDOFF.md
// session 12 — the pull-based safety net added after webhook-flutterwave
// was found to have never once received a real Flutterwave-initiated
// webhook, despite two previous "permanent fixes"). See
// supabase/tests/README.md for the deno-run-instead-of-functions-serve
// rationale.
//
// What this suite deliberately does NOT cover, and why: exercising the
// "found a real succeeded charge, confirms it" path end-to-end would need
// an actual completed Flutterwave payment to check status against — not
// fakeable without spending real money (same cost caveat
// submit-kyc-function.test.js already documents for its own vendor calls).
// That exact path was verified live this session instead, against two real
// stuck payments (topup bdddc597-aac2-4497-a5d2-7ee04bf2c145 / charge
// chg_5vwjUNk5Gt, and 0e7cb30b-8196-4d61-b458-1bb0627f187e /
// chg_zJi8cibDw5) — both correctly detected as succeeded and reconciled.
// This suite covers the two things that don't need a real payment: the
// auth guard, and the real (not mocked) "checked Flutterwave, found
// nothing, correctly left it pending" path via checkCollectionStatus
// against a fixture with no matching charge.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FLW_CLIENT_ID = process.env.FLW_CLIENT_ID;
const FLW_CLIENT_SECRET = process.env.FLW_CLIENT_SECRET;
const FLW_ENVIRONMENT = process.env.FLW_ENVIRONMENT || 'sandbox';
const CRON_SECRET = process.env.CRON_INTERNAL_SECRET || 'test-cron-secret';

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  FLW_CLIENT_ID,
  FLW_CLIENT_SECRET,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'reconcile-topups', 'index.ts');

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

async function callReconcile({ secret } = {}) {
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
  throw new Error('reconcile-topups function did not come up in time');
}

async function createTestUser() {
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone, phone_confirm: true }),
  });
  if (!res.ok) throw new Error(`createTestUser failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
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
  await admin.query('delete from public.topups where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

// =============================================================================
// Test 1: auth guard — missing/wrong X-Cron-Secret rejected, real secret and
// GET both rejected for their own reasons. Deliberately checked first and
// on its own: a gateway/auth regression here is exactly the class of bug
// (silently reject before any real code runs) that broke webhook-flutterwave
// undetected for weeks — this suite fails loudly and immediately if it
// recurs here instead.
// =============================================================================

async function testAuthGuard() {
  const noSecret = await callReconcile({ secret: null });
  log('missing X-Cron-Secret -> 401', noSecret.status === 401, JSON.stringify(noSecret.json));

  const wrongSecret = await callReconcile({ secret: 'definitely-not-it' });
  log('wrong X-Cron-Secret -> 401', wrongSecret.status === 401, JSON.stringify(wrongSecret.json));

  const getRes = await fetch(`${FUNCTION_URL}/`, {
    method: 'GET',
    headers: { 'X-Cron-Secret': CRON_SECRET },
  });
  log('GET -> 405', getRes.status === 405);
}

// =============================================================================
// Test 2: a topup old enough to be eligible, with no matching real charge at
// Flutterwave, is checked (real HTTP call to checkCollectionStatus, not
// mocked) and correctly left pending — no false-positive confirmation, no
// crash, no stray ledger entry.
// =============================================================================

async function testStuckTopupWithNoRealChargeStaysPending(admin) {
  const A = await createTestUser();

  const topupRes = await admin.query('select public.fn_buy_credit($1, 10000, $2) as id', [
    A,
    'flutterwave',
  ]);
  const topupId = topupRes.rows[0].id;
  // Backdate past MIN_AGE_MINUTES (5) so it's actually eligible this run —
  // a freshly-created topup would be correctly skipped, which is the
  // desired behavior but not what this test is checking.
  await admin.query(
    `update public.topups set created_at = now() - interval '10 minutes' where id = $1`,
    [topupId],
  );

  const result = await callReconcile();
  log(
    'reconcile call with a real (unfunded) stuck topup -> 200',
    result.status === 200,
    JSON.stringify(result.json),
  );

  const after = await admin.query('select status from public.topups where id = $1', [topupId]);
  log(
    'topup with no real charge at Flutterwave stays pending, not falsely confirmed',
    after.rows[0]?.status === 'pending',
    JSON.stringify(after.rows[0]),
  );

  const wallet = await admin.query(
    'select balance from public.wallets where user_id = $1 and kind = $2',
    [A, 'topup_credit'],
  );
  log(
    'no credits were issued for an unconfirmed topup',
    Number(wallet.rows[0]?.balance ?? 0) === 0,
    `balance=${wallet.rows[0]?.balance}`,
  );

  await deleteTestUser(admin, A);
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
      FLW_CLIENT_ID,
      FLW_CLIENT_SECRET,
      FLW_ENVIRONMENT,
      CRON_INTERNAL_SECRET: CRON_SECRET,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  try {
    await waitForFunctionReady(15000);

    await testAuthGuard();
    await testStuckTopupWithNoRealChargeStaysPending(admin);
  } finally {
    deno.kill();
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
