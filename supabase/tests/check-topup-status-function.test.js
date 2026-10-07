#!/usr/bin/env node
// Test for check-topup-status (docs/00-SESSION-HANDOFF.md session 12,
// continued) — the on-demand, no-age-gate fast path BuyCreditModal polls
// while the user is actively watching the payment screen. See
// supabase/tests/README.md for the deno-run-instead-of-functions-serve
// rationale, and mark-thread-read-function.test.js for the
// mintAccessToken pattern reused here (a locally HS256-signed JWT against
// SUPABASE_JWT_SECRET, no network round-trip needed to get a real,
// requireAuthenticatedUser-passing token for a test user).
//
// What this suite deliberately does NOT cover, and why: the "found a real
// succeeded charge, confirms it" path needs an actual completed
// Flutterwave payment to check status against — not fakeable without
// spending real money, same constraint reconcile-topups-function.test.js
// already documents for the same underlying checkCollectionStatus call.
// That exact path is what made the second live-reconciled payment this
// session feel instant once this endpoint existed to poll — verified for
// real, not just unit-tested.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const FLW_CLIENT_ID = process.env.FLW_CLIENT_ID;
const FLW_CLIENT_SECRET = process.env.FLW_CLIENT_SECRET;
const FLW_ENVIRONMENT = process.env.FLW_ENVIRONMENT || 'sandbox';

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: JWT_SECRET,
  FLW_CLIENT_ID,
  FLW_CLIENT_SECRET,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'check-topup-status', 'index.ts');

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintAccessToken(userId) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    exp: now + 3600,
    iat: now,
    sub: userId,
    role: 'authenticated',
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
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
  throw new Error('check-topup-status function did not come up in time');
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

async function callCheckStatus(token, topupId) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ topup_id: topupId }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// =============================================================================
// Test 1: auth + ownership guards.
// =============================================================================

async function testAuthAndOwnership(admin) {
  const A = await createTestUser();
  const B = await createTestUser();
  const tokenA = mintAccessToken(A);
  const tokenB = mintAccessToken(B);

  const noAuth = await callCheckStatus(null, crypto.randomUUID());
  log('missing Authorization -> 401', noAuth.status === 401, JSON.stringify(noAuth.json));

  const topupRes = await admin.query('select public.fn_buy_credit($1, 10000, $2) as id', [
    A,
    'flutterwave',
  ]);
  const topupId = topupRes.rows[0].id;

  const notFound = await callCheckStatus(tokenA, crypto.randomUUID());
  log('nonexistent topup_id -> 404', notFound.status === 404, JSON.stringify(notFound.json));

  const wrongOwner = await callCheckStatus(tokenB, topupId);
  log(
    "B checking A's topup -> 403 not_your_topup",
    wrongOwner.status === 403 && wrongOwner.json?.error === 'not_your_topup',
    JSON.stringify(wrongOwner.json),
  );

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 2: a real pending topup with no matching charge at Flutterwave (no
// age gate here, unlike reconcile-topups — checked immediately) correctly
// reports still-pending, and an already-completed topup short-circuits
// without needing a Flutterwave call at all.
// =============================================================================

async function testStatusChecks(admin) {
  const A = await createTestUser();
  const tokenA = mintAccessToken(A);

  const pendingRes = await admin.query('select public.fn_buy_credit($1, 10000, $2) as id', [
    A,
    'flutterwave',
  ]);
  const pendingId = pendingRes.rows[0].id;

  const checked = await callCheckStatus(tokenA, pendingId);
  log(
    'freshly-created pending topup (no real charge) -> 200 status pending, checked immediately (no age gate)',
    checked.status === 200 && checked.json?.status === 'pending',
    JSON.stringify(checked.json),
  );

  const completedRes = await admin.query('select public.fn_buy_credit($1, 10000, $2) as id', [
    A,
    'flutterwave',
  ]);
  const completedId = completedRes.rows[0].id;
  await admin.query("select public.fn_confirm_topup($1, 'chg_test_already_done')", [completedId]);

  const already = await callCheckStatus(tokenA, completedId);
  log(
    'already-completed topup -> 200 status completed, short-circuited',
    already.status === 200 && already.json?.status === 'completed',
    JSON.stringify(already.json),
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
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  try {
    await waitForFunctionReady(15000);

    await testAuthAndOwnership(admin);
    await testStatusChecks(admin);
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
