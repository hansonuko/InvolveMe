#!/usr/bin/env node
// End-to-end test of the mark-thread-read Edge Function
// (supabase/functions/mark-thread-read/) *and* the thread_unread_counts
// view it feeds, against the real linked dev database. Both pieces come
// from migration 20260914080000_thread_read_cursor.sql and only make
// sense tested together — the function without the view has nothing to
// verify against, the view's `auth.uid()`-scoped logic can only be
// exercised through a real authenticated REST call (a raw pg admin
// connection has no JWT claims to read), not through `deno run` alone.
// No financial logic, no live provider dependency, same class of test as
// find-user-by-phone's.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'mark-thread-read', 'index.ts');

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

// Inserted directly rather than via fn_send_message — this test is about
// read-cursor logic, not billing, and going through the real function
// would mean funding a wallet for no reason this feature cares about.
// `created_at` is passed explicitly so unread-vs-read ordering relative to
// a read-cursor timestamp is deterministic, not a real-clock race.
async function insertTestMessage(admin, threadId, senderId, createdAt) {
  await admin.query(
    `insert into public.messages (thread_id, sender_id, body, word_count, credits_charged, status, created_at)
     values ($1, $2, 'test message', 1, 1, 'released', $3)`,
    [threadId, senderId, createdAt],
  );
}

async function fetchUnreadCounts(token) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/thread_unread_counts?select=thread_id,unread_count`,
    {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    },
  );
  return res.json();
}

async function unreadCountFor(token, threadId) {
  const rows = await fetchUnreadCounts(token);
  return rows.find((r) => r.thread_id === threadId)?.unread_count ?? 0;
}

async function callMarkThreadRead(token, body) {
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
  throw new Error('mark-thread-read function did not come up in time');
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
  const C = await createTestUser(); // not a participant in A/B's thread
  const tokenA = mintAccessToken(A.id);
  const tokenB = mintAccessToken(B.id);
  const tokenC = mintAccessToken(C.id);

  let threadId;

  try {
    await waitForFunctionReady(15000);

    threadId = await createTestThread(admin, A.id, B.id);

    const noAuth = await callMarkThreadRead(null, { thread_id: threadId });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const missingThreadId = await callMarkThreadRead(tokenA, {});
    log(
      'missing thread_id -> 400 invalid_request',
      missingThreadId.status === 400 && missingThreadId.json?.error === 'invalid_request',
      JSON.stringify(missingThreadId.json),
    );

    const notFound = await callMarkThreadRead(tokenA, { thread_id: crypto.randomUUID() });
    log(
      'nonexistent thread -> 404 thread_not_found',
      notFound.status === 404 && notFound.json?.error === 'thread_not_found',
      JSON.stringify(notFound.json),
    );

    const notAParticipant = await callMarkThreadRead(tokenC, { thread_id: threadId });
    log(
      'a non-participant cannot mark the thread read -> 403 not_a_participant',
      notAParticipant.status === 403 && notAParticipant.json?.error === 'not_a_participant',
      JSON.stringify(notAParticipant.json),
    );

    // A sends a message 10 minutes ago; B has never read this thread
    // (cursor is null -> treated as epoch), so it's unread for B and,
    // correctly, not counted as unread for A (their own message).
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await insertTestMessage(admin, threadId, A.id, tenMinAgo);

    log(
      'B sees 1 unread message from A before ever marking the thread read',
      (await unreadCountFor(tokenB, threadId)) === 1,
    );
    log(
      'A does not see their own message as unread',
      (await unreadCountFor(tokenA, threadId)) === 0,
    );

    const markedByB = await callMarkThreadRead(tokenB, { thread_id: threadId });
    log(
      'B marks the thread read -> 200 ok',
      markedByB.status === 200 && markedByB.json?.ok === true,
    );

    log(
      "B's unread count drops to 0 immediately after marking read",
      (await unreadCountFor(tokenB, threadId)) === 0,
    );

    const threadRow = (
      await admin.query(
        'select participant_a_last_read_at, participant_b_last_read_at from public.threads where id = $1',
        [threadId],
      )
    ).rows[0];
    log(
      "marking read only sets the caller's own cursor column, not the other participant's",
      threadRow.participant_b_last_read_at !== null &&
        threadRow.participant_a_last_read_at === null,
      JSON.stringify(threadRow),
    );

    // A new message after B's read cursor is unread again; the earlier
    // (now-read) one must not be double-counted. Timestamp computed
    // server-side, relative to the cursor value Postgres itself just
    // wrote (threadRow.participant_b_last_read_at) — not a JS Date.now(),
    // which would race against any clock skew between this process and
    // the DB server and made this assertion genuinely flaky.
    await admin.query(
      `insert into public.messages (thread_id, sender_id, body, word_count, credits_charged, status, created_at)
       values ($1, $2, 'test message', 1, 1, 'released', $3::timestamptz + interval '1 second')`,
      [threadId, A.id, threadRow.participant_b_last_read_at],
    );
    log(
      'a message sent after the read cursor counts as unread again, and only that one',
      (await unreadCountFor(tokenB, threadId)) === 1,
    );

    // Per-message read_at (real bug fix, 2026-09-20): the first mark-read
    // call above already stamped the first message's read_at. Capture it,
    // then mark read a second time (picking up the newer message inserted
    // just above) and confirm the FIRST message's read_at is untouched —
    // the original bug was that a later read event overwrote every prior
    // message's displayed read time with its own, newer timestamp.
    const firstMessageRow = (
      await admin.query(
        `select id, read_at from public.messages where thread_id = $1 order by created_at asc limit 1`,
        [threadId],
      )
    ).rows[0];
    log(
      'the first message already has a read_at after the first mark-read',
      firstMessageRow.read_at !== null,
    );

    await new Promise((r) => setTimeout(r, 1100)); // ensure a real, measurable timestamp gap
    const markedByBAgain = await callMarkThreadRead(tokenB, { thread_id: threadId });
    log(
      'B can mark the thread read a second time -> 200 ok',
      markedByBAgain.status === 200 && markedByBAgain.json?.ok === true,
    );

    const messagesAfterSecondMark = (
      await admin.query(
        `select id, read_at from public.messages where thread_id = $1 order by created_at asc`,
        [threadId],
      )
    ).rows;
    const firstMessageAfter = messagesAfterSecondMark.find((m) => m.id === firstMessageRow.id);
    const secondMessageAfter = messagesAfterSecondMark.find((m) => m.id !== firstMessageRow.id);

    log(
      "the first message's read_at is unchanged by the second mark-read call (the actual bug)",
      firstMessageAfter.read_at.getTime() === firstMessageRow.read_at.getTime(),
      `before=${firstMessageRow.read_at.toISOString()} after=${firstMessageAfter.read_at.toISOString()}`,
    );
    log(
      'the second (newer) message gets its own, later read_at from this call',
      secondMessageAfter.read_at !== null &&
        secondMessageAfter.read_at.getTime() > firstMessageAfter.read_at.getTime(),
      `first=${firstMessageAfter.read_at.toISOString()} second=${secondMessageAfter.read_at?.toISOString()}`,
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
