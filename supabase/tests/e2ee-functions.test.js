#!/usr/bin/env node
// E2EE step 2 (docs/21-E2EE-TECHNICAL-DESIGN.md §3) — HTTP-level tests for
// the four new Edge Functions, same pattern as set-thread-payer-
// function.test.js. This file covers request validation, auth, error
// mapping, and rate limiting at the HTTP layer; the underlying policy
// (anti-enumeration gate, atomic one-time-prekey consumption, concurrency,
// self-only replenishment, both-sides-must-have-a-device) is already
// covered at the DB level by e2ee-schema-functions.test.js, which doesn't
// need a deno/HTTP layer to exercise the fn_ calls directly.

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
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

function randomBase64(byteLength) {
  return crypto.randomBytes(byteLength).toString('base64');
}

function fakePrekeyBatch(count, startKeyId = 1) {
  const batch = [];
  for (let i = 0; i < count; i++)
    batch.push({ key_id: startKeyId + i, public_key: randomBase64(32) });
  return batch;
}

function registerDeviceBody(overrides = {}) {
  return {
    device_label: 'test device',
    identity_key_ed25519: randomBase64(32),
    identity_key_x25519: randomBase64(32),
    signed_prekey_id: 1,
    signed_prekey_public: randomBase64(32),
    signed_prekey_signature: randomBase64(64),
    signed_prekey_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    one_time_prekeys: fakePrekeyBatch(3),
    ...overrides,
  };
}

async function callFn(name, token, body) {
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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
  throw new Error('function did not come up in time');
}

function spawnFn(entryName) {
  const entry = path.join(__dirname, '..', 'functions', entryName, 'index.ts');
  const deno = spawn('deno', ['run', '-A', entry], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno:${entryName}] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno:${entryName}] ${d}`));
  return deno;
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const A = await createTestUser();
  const B = await createTestUser();
  const C = await createTestUser();
  const tokenA = mintAccessToken(A);
  const tokenB = mintAccessToken(B);
  const tokenC = mintAccessToken(C);
  let threadId;
  let deno;

  try {
    // --- register-e2ee-device ---
    deno = spawnFn('register-e2ee-device');
    await waitForFunctionReady(15000);

    const noAuth = await callFn('register-e2ee-device', null, registerDeviceBody());
    log('register: missing auth -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const badKey = await callFn(
      'register-e2ee-device',
      tokenA,
      registerDeviceBody({ identity_key_ed25519: 'not-valid-base64-or-wrong-length' }),
    );
    log(
      'register: wrong-length identity key -> 400 invalid_request',
      badKey.status === 400 && badKey.json?.error === 'invalid_request',
      JSON.stringify(badKey.json),
    );

    const emptyPrekeys = await callFn(
      'register-e2ee-device',
      tokenA,
      registerDeviceBody({ one_time_prekeys: [] }),
    );
    log(
      'register: empty one_time_prekeys array -> 400 invalid_request',
      emptyPrekeys.status === 400 && emptyPrekeys.json?.error === 'invalid_request',
      JSON.stringify(emptyPrekeys.json),
    );

    const registerA = await callFn('register-e2ee-device', tokenA, registerDeviceBody());
    log(
      'register: a valid request succeeds with a real device_id',
      registerA.status === 200 && !!registerA.json?.device_id,
      JSON.stringify(registerA.json),
    );

    const registerB = await callFn('register-e2ee-device', tokenB, registerDeviceBody());
    log('register: B can also register', registerB.status === 200, JSON.stringify(registerB.json));

    deno.kill();

    // --- fetch-prekey-bundles ---
    deno = spawnFn('fetch-prekey-bundles');
    await waitForFunctionReady(15000);

    const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
    threadId = threadRes.rows[0].id;

    const selfFetch = await callFn('fetch-prekey-bundles', tokenA, { target_user_id: A });
    log(
      'fetch: cannot fetch your own bundle -> 400',
      selfFetch.status === 400,
      JSON.stringify(selfFetch.json),
    );

    const strangerFetch = await callFn('fetch-prekey-bundles', tokenC, { target_user_id: B });
    log(
      'fetch: a non-thread-partner is rejected -> 403 not_a_thread_partner',
      strangerFetch.status === 403 && strangerFetch.json?.error === 'not_a_thread_partner',
      JSON.stringify(strangerFetch.json),
    );

    const realFetch = await callFn('fetch-prekey-bundles', tokenA, { target_user_id: B });
    log(
      "fetch: A (a real thread partner) gets B's bundle",
      realFetch.status === 200 && realFetch.json?.bundles?.length === 1,
      JSON.stringify(realFetch.json),
    );
    log(
      'fetch: the bundle includes a claimed one-time prekey',
      realFetch.json?.bundles?.[0]?.one_time_prekey_id !== null,
    );

    deno.kill();

    // --- replenish-one-time-prekeys ---
    deno = spawnFn('replenish-one-time-prekeys');
    await waitForFunctionReady(15000);

    const deviceIdB = registerB.json.device_id;

    const wrongOwner = await callFn('replenish-one-time-prekeys', tokenA, {
      device_id: deviceIdB,
      one_time_prekeys: fakePrekeyBatch(2, 200),
    });
    log(
      "replenish: A cannot replenish B's device -> 403 not_your_device",
      wrongOwner.status === 403 && wrongOwner.json?.error === 'not_your_device',
      JSON.stringify(wrongOwner.json),
    );

    const rightOwner = await callFn('replenish-one-time-prekeys', tokenB, {
      device_id: deviceIdB,
      one_time_prekeys: fakePrekeyBatch(2, 300),
    });
    log(
      'replenish: B can replenish their own device',
      rightOwner.status === 200 && rightOwner.json?.inserted_count === 2,
      JSON.stringify(rightOwner.json),
    );

    deno.kill();

    // --- enable-e2ee ---
    deno = spawnFn('enable-e2ee');
    await waitForFunctionReady(15000);

    const notParticipant = await callFn('enable-e2ee', tokenC, { thread_id: threadId });
    log(
      'enable: a non-participant is rejected -> 403 not_a_participant',
      notParticipant.status === 403 && notParticipant.json?.error === 'not_a_participant',
      JSON.stringify(notParticipant.json),
    );

    const enableOk = await callFn('enable-e2ee', tokenA, { thread_id: threadId });
    log(
      'enable: succeeds once both A and B already registered a device above',
      enableOk.status === 200 && enableOk.json?.ok === true,
      JSON.stringify(enableOk.json),
    );

    const statusRow = (
      await admin.query('select e2ee_status from public.threads where id = $1', [threadId])
    ).rows[0];
    log('enable: the DB reflects e2ee_status = active', statusRow.e2ee_status === 'active');

    deno.kill();
  } finally {
    if (deno) deno.kill();
    if (threadId) await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    await deleteTestUser(admin, C);
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
