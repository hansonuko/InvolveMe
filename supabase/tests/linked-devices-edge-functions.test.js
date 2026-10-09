#!/usr/bin/env node
// End-to-end HTTP tests of the five linked-devices Edge Functions
// (docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 2) — real Deno
// processes serving the actual function files, real HTTP requests, real
// dev DB, same pattern every other *-function.test.js file in this
// directory uses (see buy-credit-function.test.js). Each function is
// spun up and torn down in turn, reusing the same `deno.serve` default
// port (8000) sequentially — no need for them to run concurrently, since
// each step of a real pairing is a separate HTTP call against the same
// underlying device_pairings/linked_devices rows regardless of timing.

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
    console.error(
      `${name} is not set. Run via \`npm run test:linked-devices-functions\` from the repo root.`,
    );
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
  // device_pairings.linked_device_id references linked_devices — must
  // clear the referencing row first.
  await admin.query('delete from public.device_pairings where confirmed_by_user_id = $1', [id]);
  await admin.query('delete from public.linked_devices where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
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

async function withFunction(entryRelativePath, fn) {
  const entry = path.join(__dirname, '..', 'functions', ...entryRelativePath.split('/'));
  const deno = spawn('deno', ['run', '-A', entry], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      SUPABASE_JWT_SECRET: JWT_SECRET,
    },
  });
  deno.stderr.on('data', (d) => process.stderr.write(`[deno:${entryRelativePath}] ${d}`));
  try {
    await waitForFunctionReady(15000);
    return await fn();
  } finally {
    deno.kill();
    // Give the OS a moment to actually free the port before the next spawn.
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function callJson(path_, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}${path_}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const phoneUser = await createTestUser();

  try {
    // --- create-device-pairing (public, unauthenticated) ----------------
    let pairingId;
    await withFunction('create-device-pairing/index.ts', async () => {
      const noBody = await callJson('/', null, {});
      log(
        'create-device-pairing rejects an empty body (missing device_label)',
        noBody.status === 400,
      );

      const res = await callJson('/', null, { device_label: 'Chrome on Windows', platform: 'web' });
      log(
        'create-device-pairing succeeds unauthenticated (no token needed)',
        res.status === 200,
        JSON.stringify(res.json),
      );
      log(
        'response has a pairing_id and expires_at',
        !!res.json?.pairing_id && !!res.json?.expires_at,
      );
      pairingId = res.json?.pairing_id;
    });

    // --- confirm-device-pairing (authenticated, the phone) ---------------
    await withFunction('confirm-device-pairing/index.ts', async () => {
      const noAuth = await callJson('/', null, { pairing_id: pairingId });
      log('confirm-device-pairing rejects an unauthenticated call (401)', noAuth.status === 401);

      const badId = await callJson('/', mintAccessToken(phoneUser), {
        pairing_id: crypto.randomUUID(),
      });
      log(
        'confirm-device-pairing 404s a nonexistent pairing_id',
        badId.status === 404 && badId.json?.error === 'pairing_not_found',
      );

      const res = await callJson('/', mintAccessToken(phoneUser), {
        pairing_id: pairingId,
        platform: 'android',
      });
      log(
        'confirm-device-pairing succeeds for the real phone user',
        res.status === 200,
        JSON.stringify(res.json),
      );
      log('response has a linked_device_id', !!res.json?.linked_device_id);

      const again = await callJson('/', mintAccessToken(phoneUser), { pairing_id: pairingId });
      log(
        're-confirming the same pairing is rejected (409)',
        again.status === 409 && again.json?.error === 'pairing_already_confirmed',
      );
    });

    // --- get-device-pairing-status (public, polled by the web client) ---
    let accessToken;
    await withFunction('get-device-pairing-status/index.ts', async () => {
      const notFound = await callJson('/', null, { pairing_id: crypto.randomUUID() });
      log('get-device-pairing-status 404s a nonexistent pairing_id', notFound.status === 404);

      const confirmed = await callJson('/', null, { pairing_id: pairingId });
      log(
        'polling a confirmed pairing returns status=confirmed with real session tokens',
        confirmed.status === 200 &&
          confirmed.json?.status === 'confirmed' &&
          !!confirmed.json?.access_token,
        JSON.stringify(confirmed.json),
      );
      accessToken = confirmed.json?.access_token;

      const secondPoll = await callJson('/', null, { pairing_id: pairingId });
      log(
        'polling again after delivery returns already_delivered, not the token a second time',
        secondPoll.status === 200 &&
          secondPoll.json?.status === 'already_delivered' &&
          !secondPoll.json?.access_token,
        JSON.stringify(secondPoll.json),
      );

      // CORS: the real browser-facing header this function must actually
      // send for involveme-web's own Origin, not assumed from source
      // alone (session 41's own prior Turnstile CORS miss is exactly the
      // class of bug this check exists to catch).
      const corsRes = await fetch(`${FUNCTION_URL}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://involveme-web.pages.dev' },
        body: JSON.stringify({ pairing_id: pairingId }),
      });
      log(
        "CORS header reflects involveme-web's real Origin",
        corsRes.headers.get('access-control-allow-origin') === 'https://involveme-web.pages.dev',
      );
    });

    // --- The delivered token is a genuinely usable session, not just a ---
    // well-formed string — proven by using it (not a manually-minted
    // test token) against an authenticated function.
    await withFunction('list-linked-devices/index.ts', async () => {
      const viaDeliveredToken = await callJson('/', accessToken, {});
      log(
        "the token get-device-pairing-status delivered actually authenticates — this is M0's own signing path exercised live, not a second copy of it",
        viaDeliveredToken.status === 200 && viaDeliveredToken.json?.devices?.length === 1,
        JSON.stringify(viaDeliveredToken.json),
      );

      const viaPhoneToken = await callJson('/', mintAccessToken(phoneUser), {});
      log(
        "fn_list_linked_devices shows the device with the pairing's own label",
        viaPhoneToken.json?.devices?.[0]?.label === 'Chrome on Windows',
      );
    });

    // --- revoke-linked-device (authenticated, the phone) -----------------
    await withFunction('revoke-linked-device/index.ts', async () => {
      const noAuth = await callJson('/', null, {});
      log('revoke-linked-device rejects an unauthenticated call (401)', noAuth.status === 401);

      const res = await callJson('/', mintAccessToken(phoneUser), {});
      log(
        'revoke-linked-device (no id = revoke all) succeeds',
        res.status === 200 && res.json?.ok === true,
      );
    });

    await withFunction('list-linked-devices/index.ts', async () => {
      const after = await callJson('/', mintAccessToken(phoneUser), {});
      log('the device no longer appears after revocation', after.json?.devices?.length === 0);
    });
  } finally {
    await deleteTestUser(admin, phoneUser);
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
