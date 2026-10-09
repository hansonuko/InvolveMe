#!/usr/bin/env node
// docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 3 — the reduced-
// privilege server-side guard (`requireAuthenticatedUser(req, {
// blockLinkedDevices: true })`, `_shared/auth.ts`) added to the four real
// money-moving Edge Functions. Real HTTP tests, same spawn-locally-then-
// hit-real-HTTP pattern every other *-function.test.js file uses.
//
// Doesn't exercise the money-moving happy path for any of these (that's
// already covered by buy-credit-function.test.js etc., unchanged) — just
// proves, for each function, that a linked-device token is rejected
// before any business logic runs, and that a normal primary-session
// token is NOT rejected by this new check (it still reaches the
// function's own body validation, which an intentionally-empty body then
// fails for an unrelated reason — proof of "passed the guard", not proof
// of a full successful transaction, which isn't this test's job).

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

function signToken(userId, payloadExtra) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    role: 'authenticated',
    sub: userId,
    iat: now,
    exp: now + 3600,
    ...payloadExtra,
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

// A real phone session never carries this claim at all — a bare,
// otherwise-ordinary token is exactly what "primary session" looks like.
// client.auth.getUser() (inside requireAuthenticatedUser) genuinely
// verifies the user behind `sub` actually exists — a real created user
// id is required, not an arbitrary uuid.
function mintPhoneToken(userId) {
  return signToken(userId, {});
}

// Exactly the shape get-device-pairing-status's own signLinkedDeviceToken
// produces (_shared/linkedDeviceToken.ts) — same claim name, same
// structure, a real companion-session token in every way that matters
// for this guard.
function mintLinkedDeviceToken(userId) {
  return signToken(userId, { linked_device_id: crypto.randomUUID() });
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

async function withFunction(name, fn) {
  const entry = path.join(__dirname, '..', 'functions', name, 'index.ts');
  const deno = spawn('deno', ['run', '-A', entry], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stderr.on('data', (d) => process.stderr.write(`[deno:${name}] ${d}`));
  try {
    await waitForFunctionReady(15000);
    return await fn();
  } finally {
    deno.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function callJson(token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function testFunction(name, userId) {
  await withFunction(name, async () => {
    const linked = await callJson(mintLinkedDeviceToken(userId), {});
    log(
      `${name}: a linked-device token is rejected (403 linked_device_restricted) before any business logic runs`,
      linked.status === 403 && linked.json?.error === 'linked_device_restricted',
      JSON.stringify(linked.json),
    );

    const primary = await callJson(mintPhoneToken(userId), {});
    log(
      `${name}: a normal primary-session token is NOT blocked by this guard (reaches body validation instead)`,
      primary.status !== 403 || primary.json?.error !== 'linked_device_restricted',
      JSON.stringify(primary.json),
    );

    const noAuth = await callJson(null, {});
    log(
      `${name}: still rejects an unauthenticated call the same as before (401)`,
      noAuth.status === 401,
    );
  });
}

async function main() {
  const userId = await createTestUser();
  try {
    await testFunction('buy-credit', userId);
    await testFunction('withdraw', userId);
    await testFunction('link-bank-account', userId);
    await testFunction('transfer-credit', userId);
  } finally {
    await deleteTestUser(userId);
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
