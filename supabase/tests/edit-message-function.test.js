#!/usr/bin/env node
// End-to-end test of the edit-message Edge Function against the real
// linked dev database — real JWTs, real HTTP function, real error
// mapping, same pattern send-message-function.test.js already
// establishes. fn_edit_message's own exhaustive logic (every rejection
// case) was already verified directly against the DB before this Edge
// Function was written; this suite proves the HTTP layer (auth, request
// validation, error-code mapping) on top of that, plus one full happy
// path and the two rejection cases that matter most for a client
// integration (not the sender; would increase cost).
//
// Also covers the e2ee envelope-replacement path at the HTTP layer
// (docs/00-SESSION-HANDOFF.md session 35 "Next session" list, item 3 —
// wiring editing into the E2EE client, apps/mobile/lib/queries/messages.ts's
// useEditMessage) — fn_edit_message's own envelope logic was already
// verified directly against the DB (e2ee-send-message-billing.test.js),
// but this Edge Function's e2ee_status lookup / envelopes-vs-body
// dispatch / E2eeEnvelopesArraySchema validation had never been exercised
// through the actual HTTP request the new client code now sends.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'edit-message', 'index.ts');

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
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function deleteTestThread(admin, threadId) {
  await admin.query(
    'delete from public.moderated_content where ref_id::text in (select id::text from public.messages where thread_id = $1)',
    [threadId],
  );
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

function wordMessage(n) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

async function seedEscrowedMessage(admin, payerId, payeeId, wordCount) {
  const {
    rows: [thread],
  } = await admin.query(
    // payer_id must be set explicitly on a direct insert — it has no
    // column default (docs/18 §C1's fn_start_thread sets it, not the
    // schema, since a DEFAULT can't reference another column of the same
    // row) — a thread seeded without it has payer_id null, and
    // fn_send_message correctly rejects every send against it.
    'insert into public.threads (participant_a, participant_b, payer_id) values ($1, $2, $1) returning id',
    [payerId, payeeId],
  );
  const {
    rows: [sent],
  } = await admin.query('select * from fn_send_message($1, $2, $3)', [
    thread.id,
    payerId,
    wordMessage(wordCount),
  ]);
  return {
    threadId: thread.id,
    messageId: sent.message_id,
    creditsCharged: Number(sent.credits_charged),
  };
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

// Same shape as e2ee-send-message-billing.test.js's own registerDevice —
// this file doesn't otherwise need the e2ee schema, so it's kept local
// rather than shared, matching this test suite's existing self-contained
// style (no shared test-helper module in this project).
async function registerDevice(admin, userId) {
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

function makeEnvelope(recipientDeviceId, ciphertextByteLength) {
  return {
    recipient_device_id: recipientDeviceId,
    ciphertext: randomBase64(ciphertextByteLength),
    ratchet_public_key: randomBase64(32),
    previous_chain_length: 0,
    message_number: 0,
    x3dh_sender_identity_key: null,
    x3dh_sender_ephemeral_key: null,
    x3dh_one_time_prekey_id: null,
  };
}

async function seedEscrowedE2eeMessage(admin, payerId, payeeId) {
  const {
    rows: [thread],
  } = await admin.query('select public.fn_start_thread($1, $2) as id', [payerId, payeeId]);
  const deviceA = await registerDevice(admin, payerId);
  const deviceB = await registerDevice(admin, payeeId);
  await admin.query('select public.fn_enable_e2ee($1, $2)', [thread.id, payerId]);

  const {
    rows: [sent],
  } = await admin.query(
    `select * from public.fn_send_message(
       p_thread_id => $1, p_sender_id => $2, p_body => $3, p_envelopes => $4::jsonb
     )`,
    [thread.id, payerId, '', JSON.stringify([makeEnvelope(deviceB, 64)])],
  );
  return {
    threadId: thread.id,
    messageId: sent.message_id,
    creditsCharged: Number(sent.credits_charged),
    deviceA,
    deviceB,
  };
}

async function callEditMessage(token, body) {
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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
  throw new Error('edit-message function did not come up in time');
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
  const tokenA = mintAccessToken(A);
  const tokenB = mintAccessToken(B);
  // Separate pair from A/B for the e2ee scenario below — fn_start_thread
  // is idempotent per (participant_a, participant_b) and would otherwise
  // hand back A/B's own already-created plaintext thread instead of a
  // fresh one, corrupting both scenarios' cleanup (found live: the first
  // version of this test reused A/B and hit exactly that).
  const C = await createTestUser();
  const D = await createTestUser();
  const tokenC = mintAccessToken(C);
  let threadId;
  let e2eeThreadId;

  try {
    await waitForFunctionReady(15000);

    const {
      rows: [aWallet],
    } = await admin.query(
      `select id from public.wallets where user_id = $1 and kind = 'topup_credit'`,
      [A],
    );
    await admin.query(
      `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 20, 'manual_adjustment')`,
      [aWallet.id],
    );

    const noAuth = await callEditMessage('', { message_id: crypto.randomUUID(), body: 'x' });
    log('missing/invalid auth -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const seed = await seedEscrowedMessage(admin, A, B, 30);
    threadId = seed.threadId;
    log(
      'seed message escrowed at 2 credits',
      seed.creditsCharged === 2,
      `credits=${seed.creditsCharged}`,
    );

    const badId = await callEditMessage(tokenA, { message_id: 'not-a-uuid', body: 'hi' });
    log(
      'non-UUID message_id -> 400 invalid_request',
      badId.status === 400 && badId.json?.error === 'invalid_request',
      JSON.stringify(badId.json),
    );

    const empty = await callEditMessage(tokenA, { message_id: seed.messageId, body: '   ' });
    log(
      'empty body -> 400 empty_message',
      empty.status === 400 && empty.json?.error === 'empty_message',
      JSON.stringify(empty.json),
    );

    const hijack = await callEditMessage(tokenB, { message_id: seed.messageId, body: 'not mine' });
    log(
      'non-sender edit -> 403 not_the_sender',
      hijack.status === 403 && hijack.json?.error === 'not_the_sender',
      JSON.stringify(hijack.json),
    );

    const tooExpensive = await callEditMessage(tokenA, {
      message_id: seed.messageId,
      body: wordMessage(60),
    });
    log(
      'tier-increasing edit -> 400 edit_would_increase_cost',
      tooExpensive.status === 400 && tooExpensive.json?.error === 'edit_would_increase_cost',
      JSON.stringify(tooExpensive.json),
    );

    const happy = await callEditMessage(tokenA, {
      message_id: seed.messageId,
      body: 'shrunk edited message',
    });
    log(
      'valid edit within tier -> 200, credits unchanged',
      happy.status === 200 && happy.json?.credits_charged === 2 && !!happy.json?.edited_at,
      JSON.stringify(happy.json),
    );

    const {
      rows: [afterEdit],
    } = await admin.query(
      'select body, word_count, credits_charged, status, edited_at from public.messages where id = $1',
      [seed.messageId],
    );
    log(
      'DB reflects the edit with no re-billing',
      afterEdit.body === 'shrunk edited message' &&
        afterEdit.word_count === 3 &&
        Number(afterEdit.credits_charged) === 2 &&
        afterEdit.status === 'escrowed' &&
        !!afterEdit.edited_at,
      JSON.stringify(afterEdit),
    );

    // Once released (B replies), editing must be rejected outright.
    const reply = await admin.query('select * from fn_send_message($1, $2, $3)', [
      threadId,
      B,
      wordMessage(10),
    ]);
    log('B replied, releasing the escrow', !!reply.rows[0], JSON.stringify(reply.rows[0]));

    const afterRelease = await callEditMessage(tokenA, {
      message_id: seed.messageId,
      body: 'too late',
    });
    log(
      'edit after release -> 409 message_not_editable',
      afterRelease.status === 409 && afterRelease.json?.error === 'message_not_editable',
      JSON.stringify(afterRelease.json),
    );

    // --- e2ee envelope-replacement path, at the HTTP layer ---
    const {
      rows: [cWallet],
    } = await admin.query(
      `select id from public.wallets where user_id = $1 and kind = 'topup_credit'`,
      [C],
    );
    await admin.query(
      `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 20, 'manual_adjustment')`,
      [cWallet.id],
    );

    const e2eeSeed = await seedEscrowedE2eeMessage(admin, C, D);
    e2eeThreadId = e2eeSeed.threadId;

    const e2eeNoEnvelopes = await callEditMessage(tokenC, {
      message_id: e2eeSeed.messageId,
      body: 'plaintext body on an e2ee thread',
    });
    log(
      'plaintext body on an e2ee-active thread -> 400, envelopes required',
      e2eeNoEnvelopes.status === 400 && e2eeNoEnvelopes.json?.error === 'invalid_request',
      JSON.stringify(e2eeNoEnvelopes.json),
    );

    const e2eeHappy = await callEditMessage(tokenC, {
      message_id: e2eeSeed.messageId,
      envelopes: [makeEnvelope(e2eeSeed.deviceB, 40)],
    });
    log(
      'e2ee edit with a valid envelope -> 200, credits unchanged',
      e2eeHappy.status === 200 &&
        e2eeHappy.json?.credits_charged === e2eeSeed.creditsCharged &&
        !!e2eeHappy.json?.edited_at,
      JSON.stringify(e2eeHappy.json),
    );

    const {
      rows: [envelopeAfterEdit],
    } = await admin.query(
      'select recipient_device_id, length(ciphertext) as ciphertext_len from public.e2ee_message_envelopes where message_id = $1',
      [e2eeSeed.messageId],
    );
    log(
      'the old envelope was replaced by exactly the new one (one row, new ciphertext length)',
      envelopeAfterEdit?.recipient_device_id === e2eeSeed.deviceB &&
        Number(envelopeAfterEdit?.ciphertext_len) === 40,
      JSON.stringify(envelopeAfterEdit),
    );

    const e2eeBadDevice = await callEditMessage(tokenC, {
      message_id: e2eeSeed.messageId,
      envelopes: [makeEnvelope(e2eeSeed.deviceA, 40)],
    });
    log(
      "e2ee edit addressed to the sender's own device -> 400 invalid_envelope_recipient_device",
      e2eeBadDevice.status === 400 &&
        e2eeBadDevice.json?.error === 'invalid_envelope_recipient_device',
      JSON.stringify(e2eeBadDevice.json),
    );
  } finally {
    deno.kill();
    if (threadId) await deleteTestThread(admin, threadId);
    if (e2eeThreadId) {
      // e2ee_message_envelopes.message_id is RESTRICT, not CASCADE
      // (20260926161500_e2ee_cascade_deletes.sql's own header comment) —
      // must go before deleteTestThread's `delete from messages` or that
      // FK blocks it.
      await admin.query(
        'delete from public.e2ee_message_envelopes where message_id in (select id from public.messages where thread_id = $1)',
        [e2eeThreadId],
      );
      await deleteTestThread(admin, e2eeThreadId);
    }
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    await deleteTestUser(admin, C);
    await deleteTestUser(admin, D);
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
