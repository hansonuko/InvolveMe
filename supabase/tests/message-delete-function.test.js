#!/usr/bin/env node
// End-to-end test of delete-message-for-me and delete-message-for-everyone
// (punch-list item 5, 2026-09-19) against the real linked dev database.
// Same pattern edit-message-function.test.js/create-group-thread-function.test.js
// already establish: spawn each function locally via `deno run`, hit it
// with a real signed JWT, tear down after. Assertions against the DB use
// a raw `pg` connection (service-role/no-RLS, fine for verification —
// group-rls-recursion.test.js is the one that specifically needs to go
// through RLS, this one doesn't).
//
// Also covers the e2ee_message_envelopes scrub added by
// 20260926180000_e2ee_delete_scrub_envelopes.sql (docs/00-SESSION-HANDOFF.md
// session 35 "Next session" list, item 1) — delete-for-everyone on an
// e2ee-active thread's message must remove every envelope row for it, not
// just blank messages.body (which is already null for those messages).

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
      `${name} is not set. Run via \`npm run test:message-delete\` from the repo root.`,
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

async function deleteTestUser(id) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

async function callFunction(token, body) {
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
  throw new Error('function did not come up in time');
}

async function withFunction(functionName, testFn) {
  const entry = path.join(__dirname, '..', 'functions', functionName, 'index.ts');
  const deno = spawn('deno', ['run', '-A', entry], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno:${functionName}] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno:${functionName}] ${d}`));
  try {
    await waitForFunctionReady(15000);
    await testFn();
  } finally {
    deno.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function insertMessage(admin, threadId, senderId, body, createdAt) {
  const row = await admin.query(
    `insert into messages (thread_id, sender_id, body, word_count, credits_charged, status, created_at)
     values ($1, $2, $3, 1, 2, 'escrowed', $4) returning id`,
    [threadId, senderId, body, createdAt],
  );
  return row.rows[0].id;
}

function randomBase64(byteLength) {
  return crypto.randomBytes(byteLength).toString('base64');
}

function fakePrekeyBatch(count, startKeyId = 1) {
  const batch = [];
  for (let i = 0; i < count; i++) {
    batch.push({ key_id: startKeyId + i, public_key: randomBase64(32) });
  }
  return batch;
}

// Registers a real e2ee_devices row (docs/21 §2) so a fabricated envelope
// row below has a valid recipient_device_id to reference — same helper
// shape as e2ee-send-message-billing.test.js's own registerDevice.
async function registerE2eeDevice(admin, userId) {
  const res = await admin.query(
    `select public.fn_register_e2ee_device($1, $2, $3, $4, $5, $6, $7, $8, $9) as device_id`,
    [
      userId,
      'test device',
      randomBase64(32),
      randomBase64(32),
      1,
      randomBase64(32),
      randomBase64(64),
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify(fakePrekeyBatch(3)),
    ],
  );
  return res.rows[0].device_id;
}

// Inserted directly (not via fn_send_message) — this file already inserts
// plaintext messages the same way; this mirrors that for an e2ee-active
// thread's envelope so the delete-scrub path can be exercised without
// pulling in the full crypto-core send flow (e2ee-send-message-billing.
// test.js's own job, not this file's).
async function insertEnvelope(admin, messageId, recipientDeviceId) {
  await admin.query(
    `insert into e2ee_message_envelopes
       (message_id, recipient_device_id, ciphertext, ratchet_public_key, previous_chain_length, message_number)
     values ($1, $2, $3, $4, 0, 0)`,
    [
      messageId,
      recipientDeviceId,
      Buffer.from(randomBase64(64), 'base64'),
      Buffer.from(randomBase64(32), 'base64'),
    ],
  );
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const a = await createTestUser();
  const b = await createTestUser();
  const outsider = await createTestUser();
  const tokenA = mintAccessToken(a);
  const tokenB = mintAccessToken(b);
  const tokenOutsider = mintAccessToken(outsider);

  const threadRow = await admin.query(
    // payer_id has no column default (docs/18 §C1) — set explicitly here
    // for consistency, even though this file never calls fn_send_message
    // (messages are seeded directly), so a future copy-paste into a test
    // that does call it doesn't inherit a null-payer_id trap.
    `insert into threads (participant_a, participant_b, payer_id) values ($1, $2, $1) returning id`,
    [a, b],
  );
  const threadId = threadRow.rows[0].id;

  const recentMsgId = await insertMessage(admin, threadId, a, 'hello there', new Date());
  const oldMsgId = await insertMessage(
    admin,
    threadId,
    a,
    'an old message',
    new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago, past the 60-min delete-for-everyone window
  );

  // --- e2ee envelope scrub setup (docs/00-SESSION-HANDOFF.md session 35
  // "Next session" list, item 1) — a dedicated e2ee-active thread, separate
  // from the plaintext one above, so this scenario doesn't interact with
  // the plaintext delete assertions already covered.
  const deviceA = await registerE2eeDevice(admin, a);
  const deviceB = await registerE2eeDevice(admin, b);
  await admin.query('select public.fn_enable_e2ee($1, $2)', [threadId, a]);
  const e2eeMsgId = await insertMessage(admin, threadId, a, null, new Date());
  await insertEnvelope(admin, e2eeMsgId, deviceB);
  await insertEnvelope(admin, e2eeMsgId, deviceA);

  try {
    // --- delete-message-for-me ---
    await withFunction('delete-message-for-me', async () => {
      const byOutsider = await callFunction(tokenOutsider, { message_id: recentMsgId });
      log(
        'for-me: a non-participant is rejected',
        byOutsider.status === 403 && byOutsider.json?.error === 'not_a_participant',
        JSON.stringify(byOutsider.json),
      );

      const byRecipient = await callFunction(tokenB, { message_id: recentMsgId });
      log(
        'for-me: the recipient (not the sender) can still delete-for-me their own view',
        byRecipient.status === 200,
        JSON.stringify(byRecipient.json),
      );

      const unknown = await callFunction(tokenA, { message_id: crypto.randomUUID() });
      log(
        'for-me: unknown message id -> message_not_found',
        unknown.status === 404 && unknown.json?.error === 'message_not_found',
        JSON.stringify(unknown.json),
      );
    });

    const deletionRow = (
      await admin.query('select 1 from message_deletions where message_id = $1 and user_id = $2', [
        recentMsgId,
        b,
      ])
    ).rowCount;
    log('message_deletions row exists for B only, not A', deletionRow === 1);

    const messageBodyUntouched = (
      await admin.query('select body, deleted_for_everyone from messages where id = $1', [
        recentMsgId,
      ])
    ).rows[0];
    log(
      'for-me never touches the messages row itself',
      messageBodyUntouched.body === 'hello there' &&
        messageBodyUntouched.deleted_for_everyone === false,
      JSON.stringify(messageBodyUntouched),
    );

    // --- delete-message-for-everyone ---
    await withFunction('delete-message-for-everyone', async () => {
      const byRecipient = await callFunction(tokenB, { message_id: recentMsgId });
      log(
        "for-everyone: the recipient cannot delete the sender's message -> not_the_sender",
        byRecipient.status === 403 && byRecipient.json?.error === 'not_the_sender',
        JSON.stringify(byRecipient.json),
      );

      const tooOld = await callFunction(tokenA, { message_id: oldMsgId });
      log(
        'for-everyone: outside the delete window -> delete_window_expired',
        tooOld.status === 409 && tooOld.json?.error === 'delete_window_expired',
        JSON.stringify(tooOld.json),
      );

      const bySender = await callFunction(tokenA, { message_id: recentMsgId });
      log(
        'for-everyone: the sender can delete a recent message -> 200',
        bySender.status === 200,
        JSON.stringify(bySender.json),
      );

      const again = await callFunction(tokenA, { message_id: recentMsgId });
      log(
        'for-everyone: deleting twice -> already_deleted',
        again.status === 409 && again.json?.error === 'already_deleted',
        JSON.stringify(again.json),
      );
    });

    const deletedRow = (
      await admin.query('select body, deleted_for_everyone from messages where id = $1', [
        recentMsgId,
      ])
    ).rows[0];
    log(
      'for-everyone actually cleared the body and set the flag',
      deletedRow.body === '' && deletedRow.deleted_for_everyone === true,
      JSON.stringify(deletedRow),
    );

    const ledgerUntouched = (
      await admin.query(
        `select count(*)::int as n from ledger_entries where ref_type = 'message' and ref_id = $1`,
        [recentMsgId],
      )
    ).rows[0].n;
    log(
      'deleting for everyone writes zero ledger_entries rows',
      ledgerUntouched === 0,
      `n=${ledgerUntouched}`,
    );

    // --- e2ee envelope scrub ---
    const envelopesBefore = (
      await admin.query(
        'select count(*)::int as n from e2ee_message_envelopes where message_id = $1',
        [e2eeMsgId],
      )
    ).rows[0].n;
    log('e2ee envelopes exist before delete', envelopesBefore === 2, `n=${envelopesBefore}`);

    await withFunction('delete-message-for-everyone', async () => {
      const bySender = await callFunction(tokenA, { message_id: e2eeMsgId });
      log(
        'for-everyone: sender can delete an e2ee-active message -> 200',
        bySender.status === 200,
        JSON.stringify(bySender.json),
      );
    });

    const envelopesAfter = (
      await admin.query(
        'select count(*)::int as n from e2ee_message_envelopes where message_id = $1',
        [e2eeMsgId],
      )
    ).rows[0].n;
    log(
      'for-everyone scrubs every e2ee_message_envelopes row for the message (sender and recipient device alike)',
      envelopesAfter === 0,
      `n=${envelopesAfter}`,
    );

    const e2eeDeletedRow = (
      await admin.query('select body, deleted_for_everyone from messages where id = $1', [
        e2eeMsgId,
      ])
    ).rows[0];
    log(
      'e2ee message row still gets the same tombstone treatment as a plaintext one',
      e2eeDeletedRow.body === '' && e2eeDeletedRow.deleted_for_everyone === true,
      JSON.stringify(e2eeDeletedRow),
    );
  } finally {
    await admin.query('delete from message_deletions where message_id = any($1)', [
      [recentMsgId, oldMsgId, e2eeMsgId],
    ]);
    await admin.query('delete from e2ee_message_envelopes where message_id = $1', [e2eeMsgId]);
    await admin.query('delete from messages where id = any($1)', [
      [recentMsgId, oldMsgId, e2eeMsgId],
    ]);
    await admin.query('delete from threads where id = $1', [threadId]);
    await deleteTestUser(a);
    await deleteTestUser(b);
    await deleteTestUser(outsider);
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
