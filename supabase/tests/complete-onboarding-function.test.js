#!/usr/bin/env node
// End-to-end test of the complete-onboarding Edge Function
// (supabase/functions/complete-onboarding/, 20260917130000_multicurrency_schema.sql,
// docs/10-UX-REFINEMENT-BACKLOG.md Batch E's E2 item). Modeled directly on
// set-thread-muted-function.test.js/mark-status-viewed-function.test.js for
// the auth/deno-run/JWT-minting scaffolding.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'complete-onboarding', 'index.ts');

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
  const user = await res.json();
  return { id: user.id, phone };
}

async function deleteTestUser(admin, id) {
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function callCompleteOnboarding(token, body) {
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
  throw new Error('complete-onboarding function did not come up in time');
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
  const B = await createTestUser();
  const C = await createTestUser();
  const tokenA = mintAccessToken(A.id);
  const tokenB = mintAccessToken(B.id);
  const tokenC = mintAccessToken(C.id);

  try {
    await waitForFunctionReady(15000);

    const noAuth = await callCompleteOnboarding(null, {
      country: 'NG',
      display_name: 'X',
      nickname: 'Y',
    });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const missingField = await callCompleteOnboarding(tokenA, { country: 'NG', display_name: 'X' });
    log(
      'missing nickname -> 400 invalid_request',
      missingField.status === 400 && missingField.json?.error === 'invalid_request',
      JSON.stringify(missingField.json),
    );

    const unknownCountry = await callCompleteOnboarding(tokenA, {
      country: 'ZZ',
      display_name: 'A User',
      nickname: 'Ayy',
    });
    log(
      'unknown country code -> 400 unknown_country',
      unknownCountry.status === 400 && unknownCountry.json?.error === 'unknown_country',
      JSON.stringify(unknownCountry.json),
    );

    const liveCountry = await callCompleteOnboarding(tokenA, {
      country: 'NG',
      display_name: 'A User',
      nickname: 'Ayy',
    });
    log(
      'NG (payments_live) -> 200, currency NGN, payments_live true',
      liveCountry.status === 200 &&
        liveCountry.json?.currency === 'NGN' &&
        liveCountry.json?.payments_live === true,
      JSON.stringify(liveCountry.json),
    );

    const afterA = (
      await admin.query(
        'select country, nickname, display_name, currency from public.users where id = $1',
        [A.id],
      )
    ).rows[0];
    log(
      'users row actually updated for A',
      afterA.country === 'NG' &&
        afterA.nickname === 'Ayy' &&
        afterA.display_name === 'A User' &&
        afterA.currency === 'NGN',
      JSON.stringify(afterA),
    );

    const replay = await callCompleteOnboarding(tokenA, {
      country: 'NG',
      display_name: 'Second Try',
      nickname: 'Nope',
    });
    log(
      'replaying onboarding for the same user -> 409 already_onboarded',
      replay.status === 409 && replay.json?.error === 'already_onboarded',
      JSON.stringify(replay.json),
    );

    const notLiveCountry = await callCompleteOnboarding(tokenB, {
      country: 'GH',
      display_name: 'B User',
      nickname: 'Bee',
    });
    log(
      'GH (not payments_live) -> 200, falls back to currency NGN, payments_live false',
      notLiveCountry.status === 200 &&
        notLiveCountry.json?.currency === 'NGN' &&
        notLiveCountry.json?.payments_live === false,
      JSON.stringify(notLiveCountry.json),
    );

    const afterB = (
      await admin.query('select country, currency from public.users where id = $1', [B.id])
    ).rows[0];
    log(
      "B's country is still recorded as GH even though currency fell back to NGN",
      afterB.country === 'GH' && afterB.currency === 'NGN',
      JSON.stringify(afterB),
    );

    // A third, untouched user confirms this function never mutates anyone
    // else's row.
    const cUntouched = (
      await admin.query('select country, display_name from public.users where id = $1', [C.id])
    ).rows[0];
    log(
      'a user who never onboarded stays untouched (country/display_name null)',
      cUntouched.country === null && cUntouched.display_name === null,
      JSON.stringify(cUntouched),
    );
  } finally {
    deno.kill();
    await deleteTestUser(admin, A.id);
    await deleteTestUser(admin, B.id);
    await deleteTestUser(admin, C.id);
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
