#!/usr/bin/env node
// End-to-end test of the link-bank-account Edge Function
// (supabase/functions/link-bank-account/). Calls the real live Flutterwave
// API for the parts that are free to call (account-resolve, same as
// buy-credit/withdraw's live testing) — unlike submit-kyc, Flutterwave
// doesn't charge per account-resolve/recipient-creation attempt, so this
// doesn't have that test's cost constraint.
//
// What this does NOT cover: the full success path (a real bank account
// whose registered name actually matches a KYC fixture). There's no known
// real account number that resolves successfully against this project's
// live Flutterwave credentials without using someone's real bank details
// (the docs' own example account number returns a real
// INVALID_ACCOUNT rejection when tried live — confirmed, not assumed) —
// same class of gap as withdraw-function.test.js never completing a real
// payout. What's covered instead: every gate reachable without one
// (auth, validation, KYC-required, and a real invalid-account rejection
// from the live account-resolve call).

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'link-bank-account', 'index.ts');

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
  await admin.query('delete from public.kyc_records where user_id = $1', [id]);
  await admin.query('delete from public.bank_accounts where user_id = $1', [id]);
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

// Inserted directly — bypasses the real (paid) Prembly call, same
// reasoning as submit-kyc-function.test.js's cost constraint. This is
// exactly the shape submit-kyc itself would have written on a real
// success.
async function insertVerifiedKycFixture(admin, userId, firstName, lastName) {
  await admin.query(
    `insert into public.kyc_records (user_id, tier, provider, provider_ref, bvn_or_nin_hash, status, verified_at, verified_first_name, verified_last_name)
     values ($1, 1, 'prembly', 'test-ref', 'test-hash', 'verified', now(), $2, $3)`,
    [userId, firstName, lastName],
  );
  await admin.query('update public.users set kyc_tier = 1 where id = $1', [userId]);
}

async function callLinkBankAccount(token, body) {
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
  throw new Error('link-bank-account function did not come up in time');
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

  const A = await createTestUser();
  const token = mintAccessToken(A);

  try {
    await waitForFunctionReady(15000);

    const noAuth = await callLinkBankAccount(null, {
      bank_code: '044',
      account_number: '0690000031',
    });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const badFormat = await callLinkBankAccount(token, { bank_code: '044', account_number: '123' });
    log(
      'account_number not 10 digits -> 400 invalid_request',
      badFormat.status === 400 && badFormat.json?.error === 'invalid_request',
      JSON.stringify(badFormat.json),
    );

    const noKyc = await callLinkBankAccount(token, {
      bank_code: '044',
      account_number: '0690000031',
    });
    log(
      'kyc_tier 0 (default) -> 403 kyc_required',
      noKyc.status === 403 && noKyc.json?.error === 'kyc_required',
      JSON.stringify(noKyc.json),
    );

    await insertVerifiedKycFixture(admin, A, 'Test', 'User');

    const invalidAccount = await callLinkBankAccount(token, {
      bank_code: '044',
      account_number: '0690000031',
    });
    log(
      'a real (live) invalid account number -> 400 invalid_account, not 503',
      invalidAccount.status === 400 && invalidAccount.json?.error === 'invalid_account',
      JSON.stringify(invalidAccount.json),
    );

    const noBankAccountRow = await admin.query(
      'select count(*) from public.bank_accounts where user_id = $1',
      [A],
    );
    log(
      'no bank_accounts row was created for the rejected attempt',
      Number(noBankAccountRow.rows[0].count) === 0,
      `count=${noBankAccountRow.rows[0].count}`,
    );
  } finally {
    deno.kill();
    await deleteTestUser(admin, A);
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
