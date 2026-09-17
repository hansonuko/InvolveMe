#!/usr/bin/env node
// End-to-end test of the find-users-by-phones Edge Function
// (supabase/functions/find-users-by-phones/, docs/10-UX-REFINEMENT-BACKLOG.md
// Batch C1's device-contacts-sync batch lookup). Modeled on
// find-user-by-phone-function.test.js, adapted for the array request/
// response shape and the "silently drop self, don't error the batch"
// difference from the single-lookup version.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'find-users-by-phones', 'index.ts');

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

async function setDisplayName(admin, userId, displayName) {
  await admin.query('update public.users set display_name = $1 where id = $2', [
    displayName,
    userId,
  ]);
}

async function deleteTestUser(admin, id) {
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function callFindUsersByPhones(token, body) {
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
  throw new Error('find-users-by-phones function did not come up in time');
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
  await setDisplayName(admin, B.id, 'Bee Test');
  const tokenA = mintAccessToken(A.id);

  try {
    await waitForFunctionReady(15000);

    const noAuth = await callFindUsersByPhones(null, { phones: [B.phone] });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const missingPhones = await callFindUsersByPhones(tokenA, {});
    log(
      'missing phones -> 400 invalid_request',
      missingPhones.status === 400 && missingPhones.json?.error === 'invalid_request',
      JSON.stringify(missingPhones.json),
    );

    const emptyArray = await callFindUsersByPhones(tokenA, { phones: [] });
    log(
      'empty phones array -> 400 invalid_request',
      emptyArray.status === 400 && emptyArray.json?.error === 'invalid_request',
      JSON.stringify(emptyArray.json),
    );

    const tooMany = await callFindUsersByPhones(tokenA, {
      phones: Array.from({ length: 2001 }, (_, i) => `+234700000${i}`),
    });
    log(
      'over 2000 phones -> 400 too_many_phones',
      tooMany.status === 400 && tooMany.json?.error === 'too_many_phones',
      JSON.stringify(tooMany.json),
    );

    const mixed = await callFindUsersByPhones(tokenA, {
      phones: [B.phone, A.phone, '+2340000000000', B.phone],
    });
    log(
      'batch of B (registered), A (self), an unregistered number, and a duplicate of B -> 200',
      mixed.status === 200,
      JSON.stringify(mixed.json),
    );
    log(
      'B is returned as a match with display_name, no phone-agnostic id mismatch',
      mixed.json?.matches?.length === 1 &&
        mixed.json.matches[0].id === B.id &&
        mixed.json.matches[0].display_name === 'Bee Test' &&
        mixed.json.matches[0].phone === B.phone.replace(/^\+/, ''),
      JSON.stringify(mixed.json?.matches),
    );
    log(
      "caller's own number is silently excluded, not returned as a match or an error",
      !mixed.json?.matches?.some((m) => m.id === A.id),
    );

    const noneRegistered = await callFindUsersByPhones(tokenA, {
      phones: ['+2340000000001', '+2340000000002'],
    });
    log(
      'a batch with no registered numbers -> 200 with an empty matches array, not an error',
      noneRegistered.status === 200 &&
        Array.isArray(noneRegistered.json?.matches) &&
        noneRegistered.json.matches.length === 0,
      JSON.stringify(noneRegistered.json),
    );
  } finally {
    deno.kill();
    await deleteTestUser(admin, A.id);
    await deleteTestUser(admin, B.id);
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
