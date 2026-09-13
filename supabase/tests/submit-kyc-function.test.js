#!/usr/bin/env node
// End-to-end test of the submit-kyc Edge Function
// (supabase/functions/submit-kyc/) — deliberately does NOT call the real
// Prembly API, unlike every other "live" test in this suite.
//
// Every Prembly BVN/NIN verification call costs real money (~₦45,
// confirmed live this session — see packages/kyc/prembly.ts's header
// comment) regardless of outcome, including a "not found" result. Baking
// a real call into an automated test that runs on every `npm run
// test:functions` invocation would mean every future test run silently
// spends real money from the account's Prembly wallet — a materially
// different situation from this project's other live-API tests
// (buy-credit, withdraw), where creating a virtual account or attempting
// a transfer to a fake recipient costs nothing.
//
// The happy path (a real BVN, actually verified) was confirmed manually
// this session with the user's own real BVN, once, with their explicit
// go-ahead given the cost — not repeated here. This test covers
// everything reachable *before* the paid provider call: auth and request
// validation.

const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

for (const [name, val] of Object.entries({
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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'submit-kyc', 'index.ts');

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

async function deleteTestUser(id) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

async function callSubmitKyc(token, body) {
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
  throw new Error('submit-kyc function did not come up in time');
}

async function main() {
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

    const noAuth = await callSubmitKyc(null, { type: 'bvn', number: '12345678901' });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const badType = await callSubmitKyc(token, { type: 'passport', number: '12345678901' });
    log(
      'invalid type -> 400 invalid_request',
      badType.status === 400 && badType.json?.error === 'invalid_request',
      JSON.stringify(badType.json),
    );

    const tooShort = await callSubmitKyc(token, { type: 'bvn', number: '123' });
    log(
      'number shorter than 11 digits -> 400 invalid_request',
      tooShort.status === 400 && tooShort.json?.error === 'invalid_request',
      JSON.stringify(tooShort.json),
    );

    const nonDigits = await callSubmitKyc(token, { type: 'bvn', number: '1234567890a' });
    log(
      'non-digit number -> 400 invalid_request',
      nonDigits.status === 400 && nonDigits.json?.error === 'invalid_request',
      JSON.stringify(nonDigits.json),
    );

    const missingNumber = await callSubmitKyc(token, { type: 'nin' });
    log(
      'missing number -> 400 invalid_request',
      missingNumber.status === 400 && missingNumber.json?.error === 'invalid_request',
      JSON.stringify(missingNumber.json),
    );
  } finally {
    deno.kill();
    await deleteTestUser(A);
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
