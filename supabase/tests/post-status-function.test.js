#!/usr/bin/env node
// End-to-end test of the post-status Edge Function
// (supabase/functions/post-status/) against the real linked dev database —
// real HTTP requests, real minted JWTs, real Admin-API-created test users.
// Run via `npm run test:functions`.
//
// No Flutterwave dependency (unlike withdraw-function.test.js /
// webhook-flutterwave-function.test.js) — this function only ever touches
// the caller's own topup_credit wallet, so every path here is fully
// exercised for real, not working around a stubbed provider call.
//
// See README.md for the deno-run-instead-of-functions-serve rationale
// (unchanged from send-message-function.test.js).

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'post-status', 'index.ts');

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

// Same disable-trigger/delete-ledger-entries sequence as every other
// function test in this suite — a funded wallet can't cascade-delete
// through auth.users otherwise (ledger_entries is append-only, CLAUDE.md
// rule #4).
async function deleteTestUser(admin, id) {
  await admin.query('begin');
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('commit');
  await admin.query('delete from public.status_updates where user_id = $1', [id]);
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function walletRow(admin, userId, kind) {
  const r = await admin.query(
    'select id, balance from public.wallets where user_id=$1 and kind=$2',
    [userId, kind],
  );
  return r.rows[0];
}

async function ledgerSum(admin, walletId) {
  const r = await admin.query(
    'select coalesce(sum(amount), 0) as sum from public.ledger_entries where wallet_id = $1',
    [walletId],
  );
  return Number(r.rows[0].sum);
}

async function pricingValue(admin, key) {
  const r = await admin.query('select value from public.pricing_config where key = $1', [key]);
  return Number(r.rows[0].value);
}

async function fundTopupCredit(admin, userId, credits) {
  const wallet = await walletRow(admin, userId, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'topup_purchase')`,
    [wallet.id, credits],
  );
}

async function callPostStatus(token, body) {
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
  throw new Error('post-status function did not come up in time');
}

// =============================================================================
// Test 1: a text-only status debits status_upload_credits_text, and a media
// status debits status_upload_credits_media — proving the function actually
// branches on media_url rather than always charging one rate. Ledger
// conservation checked directly against the DB after each.
// =============================================================================

async function testTextAndMediaCharges(admin) {
  const textCredits = await pricingValue(admin, 'status_upload_credits_text');
  const mediaCredits = await pricingValue(admin, 'status_upload_credits_media');

  const A = await createTestUser();
  const token = mintAccessToken(A);
  await fundTopupCredit(admin, A, textCredits + mediaCredits);

  const textRes = await callPostStatus(token, {
    caption: 'Just a caption, no media',
    text_style: 'wine',
  });
  log(
    `text-only status charges status_upload_credits_text (${textCredits})`,
    textRes.status === 200 && textRes.json?.credits_charged === textCredits,
    JSON.stringify(textRes.json),
  );

  const textStyleRow = await admin.query(
    'select text_style from public.status_updates where id = $1',
    [textRes.json?.status_id],
  );
  log(
    'text_style round-trips into the status_updates row',
    textStyleRow.rows[0]?.text_style === 'wine',
    JSON.stringify(textStyleRow.rows[0]),
  );

  const mediaRes = await callPostStatus(token, {
    media_path: `${A}/1.jpg`,
    caption: 'with a photo',
  });
  log(
    `media status charges status_upload_credits_media (${mediaCredits})`,
    mediaRes.status === 200 && mediaRes.json?.credits_charged === mediaCredits,
    JSON.stringify(mediaRes.json),
  );

  const wallet = await walletRow(admin, A, 'topup_credit');
  log(
    'payer_balance_after on the second call matches the wallet balance after both debits',
    Number(wallet.balance) === mediaRes.json?.payer_balance_after,
    `wallet=${wallet.balance} response=${mediaRes.json?.payer_balance_after}`,
  );

  const sum = await ledgerSum(admin, wallet.id);
  log(
    'ledger conservation holds after both status posts',
    sum === Number(wallet.balance),
    `ledger_sum=${sum} balance=${wallet.balance}`,
  );

  const rows = await admin.query(
    'select media_path, caption, credits_charged, expires_at, created_at from public.status_updates where user_id = $1 order by created_at',
    [A],
  );
  log(
    'both status_updates rows were actually inserted',
    rows.rows.length === 2,
    `count=${rows.rows.length}`,
  );
  const expiresOk = rows.rows.every((r) => {
    const hours = (new Date(r.expires_at) - new Date(r.created_at)) / (1000 * 60 * 60);
    return Math.abs(hours - 24) < 0.01;
  });
  log('expires_at is set to created_at + 24h on every row', expiresOk);

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 2: error mapping — auth, validation, insufficient_credit (structured
// shape, same convention as send-message), and wallet_frozen.
// =============================================================================

async function testErrorMapping(admin) {
  const textCredits = await pricingValue(admin, 'status_upload_credits_text');

  const noAuth = await callPostStatus(null, { caption: 'hi' });
  log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

  const A = await createTestUser();
  const token = mintAccessToken(A);

  const empty = await callPostStatus(token, {});
  log(
    'neither caption nor media_path -> 400 empty_status',
    empty.status === 400 && empty.json?.error === 'empty_status',
    JSON.stringify(empty.json),
  );

  const blank = await callPostStatus(token, { caption: '   ', media_path: '' });
  log(
    'whitespace-only caption and empty media_path -> 400 empty_status',
    blank.status === 400 && blank.json?.error === 'empty_status',
    JSON.stringify(blank.json),
  );

  const badType = await callPostStatus(token, { caption: 123 });
  log(
    'non-string caption -> 400 invalid_request',
    badType.status === 400 && badType.json?.error === 'invalid_request',
    JSON.stringify(badType.json),
  );

  const badTextStyle = await callPostStatus(token, { caption: 'hi', text_style: 42 });
  log(
    'non-string text_style -> 400 invalid_request',
    badTextStyle.status === 400 && badTextStyle.json?.error === 'invalid_request',
    JSON.stringify(badTextStyle.json),
  );

  // A has zero balance (default state) — insufficient_credit with the
  // structured credits_required/credits_available shape.
  const noFunds = await callPostStatus(token, { caption: 'no funds for this' });
  log(
    'zero balance -> 402 insufficient_credit with structured amounts',
    noFunds.status === 402 &&
      noFunds.json?.error === 'insufficient_credit' &&
      noFunds.json?.credits_required === textCredits &&
      noFunds.json?.credits_available === 0,
    JSON.stringify(noFunds.json),
  );

  await fundTopupCredit(admin, A, textCredits * 5);
  const wallet = await walletRow(admin, A, 'topup_credit');
  await admin.query('update public.wallets set is_frozen = true where id = $1', [wallet.id]);

  const frozen = await callPostStatus(token, { caption: 'should be rejected' });
  log(
    'frozen wallet -> 403 wallet_frozen',
    frozen.status === 403 && frozen.json?.error === 'wallet_frozen',
    JSON.stringify(frozen.json),
  );

  await admin.query('update public.wallets set is_frozen = false where id = $1', [wallet.id]);
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

    await testTextAndMediaCharges(admin);
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
