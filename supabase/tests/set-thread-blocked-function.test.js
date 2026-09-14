#!/usr/bin/env node
// End-to-end test of the set-thread-blocked Edge Function
// (supabase/functions/set-thread-blocked/) against the real linked dev
// database. Covers the actual gap this migration closed: threads.blocked_by
// (renamed from is_blocked) and its enforcement in fn_send_message
// existed before this session, but nothing ever set it — this is that
// missing write path, plus the "only the blocker can unblock" rule a
// plain boolean couldn't have supported.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'set-thread-blocked', 'index.ts');

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

async function callSetThreadBlocked(token, body) {
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
  throw new Error('set-thread-blocked function did not come up in time');
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

    const noAuth = await callSetThreadBlocked(null, { thread_id: threadId, blocked: true });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const badBody = await callSetThreadBlocked(tokenA, { thread_id: threadId });
    log(
      'missing blocked field -> 400 invalid_request',
      badBody.status === 400 && badBody.json?.error === 'invalid_request',
      JSON.stringify(badBody.json),
    );

    const notFound = await callSetThreadBlocked(tokenA, {
      thread_id: crypto.randomUUID(),
      blocked: true,
    });
    log(
      'nonexistent thread -> 404 thread_not_found',
      notFound.status === 404 && notFound.json?.error === 'thread_not_found',
      JSON.stringify(notFound.json),
    );

    const notAParticipant = await callSetThreadBlocked(tokenC, {
      thread_id: threadId,
      blocked: true,
    });
    log(
      'a non-participant cannot block the thread -> 403 not_a_participant',
      notAParticipant.status === 403 && notAParticipant.json?.error === 'not_a_participant',
      JSON.stringify(notAParticipant.json),
    );

    const blockedByA = await callSetThreadBlocked(tokenA, { thread_id: threadId, blocked: true });
    log('A blocks the thread -> 200 ok', blockedByA.status === 200 && blockedByA.json?.ok === true);

    const threadRow = (
      await admin.query('select blocked_by from public.threads where id = $1', [threadId])
    ).rows[0];
    log('blocked_by is set to A', threadRow.blocked_by === A.id, JSON.stringify(threadRow));

    const sendAfterBlock = await admin
      .query('select * from public.fn_send_message($1, $2, $3)', [threadId, B.id, 'hello?'])
      .catch((e) => ({ error: e }));
    log(
      'fn_send_message is rejected on a blocked thread',
      sendAfterBlock.error && /thread_blocked/.test(sendAfterBlock.error.message),
      sendAfterBlock.error ? sendAfterBlock.error.message : 'did not throw',
    );

    const doubleBlockByB = await callSetThreadBlocked(tokenB, {
      thread_id: threadId,
      blocked: true,
    });
    log(
      'a second block call (by the other participant) is a no-op, not an error',
      doubleBlockByB.status === 200,
      JSON.stringify(doubleBlockByB.json),
    );
    const stillA = (
      await admin.query('select blocked_by from public.threads where id = $1', [threadId])
    ).rows[0];
    log(
      "blocked_by stays A, not overwritten by B's redundant block call",
      stillA.blocked_by === A.id,
    );

    const unblockByB = await callSetThreadBlocked(tokenB, { thread_id: threadId, blocked: false });
    log(
      "B (who didn't block it) cannot unblock -> 403 not_the_blocker",
      unblockByB.status === 403 && unblockByB.json?.error === 'not_the_blocker',
      JSON.stringify(unblockByB.json),
    );

    const unblockByA = await callSetThreadBlocked(tokenA, { thread_id: threadId, blocked: false });
    log('A (the actual blocker) can unblock -> 200 ok', unblockByA.status === 200);

    const unblockedRow = (
      await admin.query('select blocked_by from public.threads where id = $1', [threadId])
    ).rows[0];
    log('blocked_by is null again after unblocking', unblockedRow.blocked_by === null);
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
