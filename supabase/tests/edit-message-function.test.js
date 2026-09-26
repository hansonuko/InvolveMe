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
  let threadId;

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
  } finally {
    deno.kill();
    if (threadId) await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
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
