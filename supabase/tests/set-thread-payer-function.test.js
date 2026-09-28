#!/usr/bin/env node
// End-to-end test of the set-thread-payer Edge Function
// (supabase/functions/set-thread-payer/, 20260926140000_thread_payer_role.sql,
// docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §C1). Modeled directly on
// set-thread-muted-function.test.js — this file only covers request
// validation and DB-error-to-HTTP mapping; the actual policy (self-only,
// stepdown rules, ledger correctness after a flip) is covered at the DB
// level by thread-payer-functions.test.js, which doesn't need a deno/HTTP
// layer to exercise fn_set_thread_payer directly. Claiming/taking over the
// payer role is instant and ungated as of
// 20260927120000_payer_takeover_instant_flip_burst_signal.sql — there is no
// idle gate left to test here.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'set-thread-payer', 'index.ts');

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
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function createTestThread(admin, payerId, payeeId) {
  const res = await admin.query('select public.fn_start_thread($1, $2) as id', [payerId, payeeId]);
  return res.rows[0].id;
}

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.thread_payer_history where thread_id = $1', [threadId]);
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function fundTopupCredit(admin, userId, credits) {
  const wallet = (
    await admin.query('select id from public.wallets where user_id = $1 and kind = $2', [
      userId,
      'topup_credit',
    ])
  ).rows[0];
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.id, credits],
  );
}

async function sendMessageDirect(admin, threadId, senderId, body) {
  await admin.query('select public.fn_send_message($1, $2, $3)', [threadId, senderId, body]);
}

async function callSetThreadPayer(token, body) {
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
  throw new Error('set-thread-payer function did not come up in time');
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
  const tokenA = mintAccessToken(A);
  const tokenB = mintAccessToken(B);
  const tokenC = mintAccessToken(C);

  let threadId;

  try {
    await waitForFunctionReady(15000);

    threadId = await createTestThread(admin, A, B);
    await fundTopupCredit(admin, A, 50);
    // A real message, not just a bare thread, so last_message_at is
    // recent — proves the instant-takeover assertion below isn't just
    // trivially true because a never-messaged thread happens to have no
    // activity to be blocked by in the first place.
    await sendMessageDirect(admin, threadId, A, 'hello');

    const noAuth = await callSetThreadPayer(null, { thread_id: threadId, new_payer_id: A });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const missingThread = await callSetThreadPayer(tokenA, { new_payer_id: A });
    log(
      'missing thread_id -> 400 invalid_request',
      missingThread.status === 400 && missingThread.json?.error === 'invalid_request',
      JSON.stringify(missingThread.json),
    );

    const notFound = await callSetThreadPayer(tokenA, {
      thread_id: crypto.randomUUID(),
      new_payer_id: A,
    });
    log(
      'nonexistent thread -> 404 thread_not_found',
      notFound.status === 404 && notFound.json?.error === 'thread_not_found',
      JSON.stringify(notFound.json),
    );

    const notAParticipant = await callSetThreadPayer(tokenC, {
      thread_id: threadId,
      new_payer_id: C,
    });
    log(
      'a non-participant cannot touch the payer role -> 403 not_a_participant',
      notAParticipant.status === 403 && notAParticipant.json?.error === 'not_a_participant',
      JSON.stringify(notAParticipant.json),
    );

    const appointOther = await callSetThreadPayer(tokenA, {
      thread_id: threadId,
      new_payer_id: B,
    });
    log(
      'A trying to name B as payer -> 403 can_only_appoint_self (rejected before ever reaching the DB)',
      appointOther.status === 403 && appointOther.json?.error === 'can_only_appoint_self',
      JSON.stringify(appointOther.json),
    );

    // A willing payer must never be blocked, even on a thread with fresh
    // activity — 20260927120000_payer_takeover_instant_flip_burst_signal.sql
    // removed the 24h idle gate that used to reject exactly this case (a
    // real, reported incident: a user unable to take over paying during
    // what could have been an emergency).
    const takeoverInstant = await callSetThreadPayer(tokenB, {
      thread_id: threadId,
      new_payer_id: B,
    });
    log(
      'B takes over from A INSTANTLY, even on a thread with fresh activity -> 200 ok',
      takeoverInstant.status === 200 && takeoverInstant.json?.payer_id === B,
      JSON.stringify(takeoverInstant.json),
    );

    const aStepsDownNotPayer = await callSetThreadPayer(tokenA, {
      thread_id: threadId,
      new_payer_id: null,
    });
    log(
      'A (no longer the payer) trying to step down -> 403 not_current_payer',
      aStepsDownNotPayer.status === 403 && aStepsDownNotPayer.json?.error === 'not_current_payer',
      JSON.stringify(aStepsDownNotPayer.json),
    );

    const bStepsDown = await callSetThreadPayer(tokenB, {
      thread_id: threadId,
      new_payer_id: null,
    });
    log(
      'B (the actual current payer) steps down -> 200 ok',
      bStepsDown.status === 200 && bStepsDown.json?.payer_id === null,
      JSON.stringify(bStepsDown.json),
    );

    const bClaims = await callSetThreadPayer(tokenB, { thread_id: threadId, new_payer_id: B });
    log(
      'B claims out of a null payer_id, also instantly (no idle requirement either way)',
      bClaims.status === 200 && bClaims.json?.payer_id === B,
      JSON.stringify(bClaims.json),
    );

    const payerRow = (
      await admin.query('select payer_id from public.threads where id = $1', [threadId])
    ).rows[0];
    log('the DB reflects B as the new payer', payerRow.payer_id === B, JSON.stringify(payerRow));
  } finally {
    deno.kill();
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
