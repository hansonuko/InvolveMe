#!/usr/bin/env node
// End-to-end test of the mark-status-viewed Edge Function
// (supabase/functions/mark-status-viewed/) *and* the
// status_updates_select_visible_to_thread_partner RLS policy it sits next
// to, against the real linked dev database. Both come from migration
// 20260916090000_status_visibility_and_view_tracking.sql. Same class of
// test, and same structure, as mark-thread-read-function.test.js — read
// state, no financial logic, no live provider dependency.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'mark-status-viewed', 'index.ts');

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

async function createTestStatus(admin, userId, caption) {
  const res = await admin.query(
    `insert into public.status_updates (user_id, caption, credits_charged, expires_at)
     values ($1, $2, 3, now() + interval '24 hours') returning id`,
    [userId, caption],
  );
  return res.rows[0].id;
}

async function deleteTestStatus(admin, statusId) {
  await admin.query('delete from public.status_views where status_id = $1', [statusId]);
  await admin.query('delete from public.status_updates where id = $1', [statusId]);
}

async function callMarkStatusViewed(token, body) {
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
  throw new Error('mark-status-viewed function did not come up in time');
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

  const A = await createTestUser(); // poster
  const B = await createTestUser(); // thread partner of A
  const C = await createTestUser(); // not a thread partner of A
  const tokenA = mintAccessToken(A.id);
  const tokenB = mintAccessToken(B.id);
  const tokenC = mintAccessToken(C.id);

  let threadId;
  let statusId;

  try {
    await waitForFunctionReady(15000);

    threadId = await createTestThread(admin, A.id, B.id);
    statusId = await createTestStatus(admin, A.id, 'hello from A');

    const noAuth = await callMarkStatusViewed(null, { status_id: statusId });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const missingStatusId = await callMarkStatusViewed(tokenB, {});
    log(
      'missing status_id -> 400 invalid_request',
      missingStatusId.status === 400 && missingStatusId.json?.error === 'invalid_request',
      JSON.stringify(missingStatusId.json),
    );

    const notFound = await callMarkStatusViewed(tokenB, { status_id: crypto.randomUUID() });
    log(
      'nonexistent status -> 404 status_not_found',
      notFound.status === 404 && notFound.json?.error === 'status_not_found',
      JSON.stringify(notFound.json),
    );

    const notVisible = await callMarkStatusViewed(tokenC, { status_id: statusId });
    log(
      'a non-thread-partner cannot mark the status viewed -> 403 not_visible',
      notVisible.status === 403 && notVisible.json?.error === 'not_visible',
      JSON.stringify(notVisible.json),
    );

    const markedByB = await callMarkStatusViewed(tokenB, { status_id: statusId });
    log(
      'thread partner B marks the status viewed -> 200 ok',
      markedByB.status === 200 && markedByB.json?.ok === true,
      JSON.stringify(markedByB.json),
    );

    const viewRow = await admin.query(
      'select viewed_at from public.status_views where status_id = $1 and viewer_id = $2',
      [statusId, B.id],
    );
    log('a status_views row was actually recorded for B', viewRow.rows.length === 1);

    const markedAgain = await callMarkStatusViewed(tokenB, { status_id: statusId });
    log(
      'replaying the same view is idempotent -> still 200 ok',
      markedAgain.status === 200 && markedAgain.json?.ok === true,
    );
    const viewRowAfterReplay = await admin.query(
      'select count(*)::int as n from public.status_views where status_id = $1 and viewer_id = $2',
      [statusId, B.id],
    );
    log('replay does not create a second row', viewRowAfterReplay.rows[0].n === 1);

    const markedByPoster = await callMarkStatusViewed(tokenA, { status_id: statusId });
    log(
      'the poster viewing their own status is a no-op 200, not an error',
      markedByPoster.status === 200 && markedByPoster.json?.ok === true,
    );
    const posterViewRow = await admin.query(
      'select count(*)::int as n from public.status_views where status_id = $1 and viewer_id = $2',
      [statusId, A.id],
    );
    log(
      'no status_views row is inserted for the poster viewing their own status',
      posterViewRow.rows[0].n === 0,
    );

    // Block the thread A->B, confirm B can no longer mark A's status viewed
    await admin.query('select public.fn_set_thread_blocked($1, $2, true)', [threadId, A.id]);
    const blockedStatusId = await createTestStatus(admin, A.id, 'posted after blocking');
    const notVisibleAfterBlock = await callMarkStatusViewed(tokenB, { status_id: blockedStatusId });
    log(
      'a blocked thread partner cannot mark the status viewed -> 403 not_visible',
      notVisibleAfterBlock.status === 403 && notVisibleAfterBlock.json?.error === 'not_visible',
      JSON.stringify(notVisibleAfterBlock.json),
    );
    await deleteTestStatus(admin, blockedStatusId);
    await admin.query('select public.fn_set_thread_blocked($1, $2, false)', [threadId, A.id]);
  } finally {
    deno.kill();
    if (statusId) await deleteTestStatus(admin, statusId);
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
