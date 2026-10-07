#!/usr/bin/env node
// End-to-end test of the buy-credit Edge Function
// (supabase/functions/buy-credit/) — the first test in this suite that
// calls the REAL Flutterwave API for collections (production, live
// credentials — see docs/00-SESSION-HANDOFF.md's session-3 section). Every
// run here creates a real Flutterwave Customer + a real dynamic
// bank-transfer virtual account for a small amount (₦100 by default). That
// is a genuine, harmless side effect on the connected Flutterwave account
// (the account already has at least one manually-created test customer
// from initial account setup) — nothing here completes an actual bank
// transfer, so no real money moves and every topup this test creates stays
// 'pending' forever, exactly like an abandoned real checkout would.
//
// See README.md for the deno-run-instead-of-functions-serve rationale.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: JWT_SECRET,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'buy-credit', 'index.ts');

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
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function pricingValue(admin, key) {
  const r = await admin.query('select value from public.pricing_config where key = $1', [key]);
  return Number(r.rows[0].value);
}

async function callBuyCredit(token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
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
  throw new Error('buy-credit function did not come up in time');
}

// =============================================================================
// Test 1: a real ₦100 top-up against the live Flutterwave API — creates a
// real Customer + a real dynamic bank-transfer virtual account, and proves
// the fee/credit math and provider-reference persistence, not just that the
// HTTP call didn't throw. A second call for the same user proves the
// Customer gets reused via users.provider_customer_id, not re-created.
// =============================================================================

async function testRealTopupAgainstLiveFlutterwave(admin) {
  const feeBps = await pricingValue(admin, 'platform_topup_fee_bps');
  const unitKobo = await pricingValue(admin, 'credit_unit_kobo');
  const amountKobo = 10000; // ₦100 — small on purpose, per the user's own "small real amounts are fine"

  const A = await createTestUser();
  const token = mintAccessToken(A);

  const res = await callBuyCredit(token, { amount_kobo: amountKobo });
  log(
    'a real ₦100 top-up request succeeds against live Flutterwave (200)',
    res.status === 200,
    JSON.stringify(res.json),
  );

  const expectedFee = Math.round((amountKobo * feeBps) / 10000);
  const expectedCredits = Math.floor((amountKobo - expectedFee) / unitKobo);
  log(
    `fee/credit math matches docs/03 §3 (fee=${expectedFee}, credits=${expectedCredits})`,
    res.json?.platform_fee_kobo === expectedFee && res.json?.credits_issued === expectedCredits,
    JSON.stringify(res.json),
  );

  log(
    'response includes a real bank_transfer virtual account number',
    typeof res.json?.bank_transfer?.account_number === 'string' &&
      res.json.bank_transfer.account_number.length > 0,
    JSON.stringify(res.json?.bank_transfer),
  );

  const topupRow = await admin.query(
    'select status, provider_ref from public.topups where id = $1',
    [res.json?.topup_id],
  );
  log(
    "the topup stays 'pending' (no money has actually moved) with a real provider_ref recorded",
    topupRow.rows[0]?.status === 'pending' && !!topupRow.rows[0]?.provider_ref,
    JSON.stringify(topupRow.rows[0]),
  );

  const userRow = await admin.query('select provider_customer_id from public.users where id = $1', [
    A,
  ]);
  const customerId = userRow.rows[0]?.provider_customer_id;
  log(
    'a real Flutterwave customer id got cached on users.provider_customer_id',
    typeof customerId === 'string' && customerId.length > 0,
    `provider_customer_id=${customerId}`,
  );

  // Second top-up for the same user — should reuse the cached customer id
  // rather than creating a second Customer object at Flutterwave.
  const res2 = await callBuyCredit(token, { amount_kobo: amountKobo });
  log(
    'a second top-up for the same user also succeeds (200)',
    res2.status === 200,
    JSON.stringify(res2.json),
  );

  const userRowAfter = await admin.query(
    'select provider_customer_id from public.users where id = $1',
    [A],
  );
  log(
    'the cached provider_customer_id is unchanged after a second top-up (Customer reused, not recreated)',
    userRowAfter.rows[0]?.provider_customer_id === customerId,
    `before=${customerId} after=${userRowAfter.rows[0]?.provider_customer_id}`,
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 2: error mapping — auth and request validation. Deliberately doesn't
// re-exercise the live provider call (already covered above); this is the
// DB/auth layer only.
// =============================================================================

async function testErrorMapping(admin) {
  const noAuth = await callBuyCredit(null, { amount_kobo: 10000 });
  log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

  const A = await createTestUser();
  const token = mintAccessToken(A);

  const badBody = await callBuyCredit(token, {});
  log(
    'missing amount_kobo -> 400 invalid_request',
    badBody.status === 400 && badBody.json?.error === 'invalid_request',
    JSON.stringify(badBody.json),
  );

  const negative = await callBuyCredit(token, { amount_kobo: -100 });
  log(
    'negative amount_kobo -> 400 invalid_request',
    negative.status === 400 && negative.json?.error === 'invalid_request',
    JSON.stringify(negative.json),
  );

  const nonInteger = await callBuyCredit(token, { amount_kobo: 100.5 });
  log(
    'non-integer amount_kobo -> 400 invalid_request',
    nonInteger.status === 400 && nonInteger.json?.error === 'invalid_request',
    JSON.stringify(nonInteger.json),
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
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  try {
    await waitForFunctionReady(15000);

    await testRealTopupAgainstLiveFlutterwave(admin);
    await testErrorMapping(admin);
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
