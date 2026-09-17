#!/usr/bin/env node
// End-to-end test of the set-thread-muted Edge Function
// (supabase/functions/set-thread-muted/, 20260917110000_thread_mute.sql,
// docs/10-UX-REFINEMENT-BACKLOG.md Batch G part 2). Modeled directly on
// set-thread-blocked-function.test.js, minus the "only the blocker can
// unblock" precedence rule — mute has no such rule: either participant can
// mute/unmute independently, and doing so never touches the other
// participant's own flag.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'set-thread-muted', 'index.ts');

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
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function createTestThread(admin, payerId, payeeId) {
  const res = await admin.query('select public.fn_start_thread($1, $2) as id', [payerId, payeeId]);
  return res.rows[0].id;
}

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function callSetThreadMuted(token, body) {
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
  throw new Error('set-thread-muted function did not come up in time');
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

  let threadId;

  try {
    await waitForFunctionReady(15000);

    threadId = await createTestThread(admin, A.id, B.id);

    const noAuth = await callSetThreadMuted(null, { thread_id: threadId, muted: true });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const badBody = await callSetThreadMuted(tokenA, { thread_id: threadId });
    log(
      'missing muted field -> 400 invalid_request',
      badBody.status === 400 && badBody.json?.error === 'invalid_request',
      JSON.stringify(badBody.json),
    );

    const notFound = await callSetThreadMuted(tokenA, {
      thread_id: crypto.randomUUID(),
      muted: true,
    });
    log(
      'nonexistent thread -> 404 thread_not_found',
      notFound.status === 404 && notFound.json?.error === 'thread_not_found',
      JSON.stringify(notFound.json),
    );

    const notAParticipant = await callSetThreadMuted(tokenC, { thread_id: threadId, muted: true });
    log(
      'a non-participant cannot mute the thread -> 403 not_a_participant',
      notAParticipant.status === 403 && notAParticipant.json?.error === 'not_a_participant',
      JSON.stringify(notAParticipant.json),
    );

    const mutedByA = await callSetThreadMuted(tokenA, { thread_id: threadId, muted: true });
    log(
      'A mutes the thread -> 200 ok, muted: true',
      mutedByA.status === 200 && mutedByA.json?.muted === true,
    );

    const afterAMutes = (
      await admin.query('select muted_by_a, muted_by_b from public.threads where id = $1', [
        threadId,
      ])
    ).rows[0];
    log(
      'muted_by_a is true, muted_by_b untouched',
      afterAMutes.muted_by_a === true && afterAMutes.muted_by_b === false,
      JSON.stringify(afterAMutes),
    );

    const mutedByB = await callSetThreadMuted(tokenB, { thread_id: threadId, muted: true });
    log('B independently mutes the same thread -> 200 ok', mutedByB.status === 200);

    const afterBothMute = (
      await admin.query('select muted_by_a, muted_by_b from public.threads where id = $1', [
        threadId,
      ])
    ).rows[0];
    log(
      'both muted_by_a and muted_by_b are true once both participants mute',
      afterBothMute.muted_by_a === true && afterBothMute.muted_by_b === true,
      JSON.stringify(afterBothMute),
    );

    const unmutedByA = await callSetThreadMuted(tokenA, { thread_id: threadId, muted: false });
    log(
      'A unmutes -> 200 ok, muted: false',
      unmutedByA.status === 200 && unmutedByA.json?.muted === false,
    );

    const afterAUnmutes = (
      await admin.query('select muted_by_a, muted_by_b from public.threads where id = $1', [
        threadId,
      ])
    ).rows[0];
    log(
      "A unmuting leaves B's own mute flag alone (no shared precedence, unlike blocking)",
      afterAUnmutes.muted_by_a === false && afterAUnmutes.muted_by_b === true,
      JSON.stringify(afterAUnmutes),
    );
  } finally {
    deno.kill();
    if (threadId) await deleteTestThread(admin, threadId);
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
