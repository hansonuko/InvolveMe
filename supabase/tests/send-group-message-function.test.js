#!/usr/bin/env node
// End-to-end test of the send-group-message Edge Function
// (supabase/functions/send-group-message/) against the real linked dev
// database. Sets up its own group directly via fn_create_group_thread
// (already covered by create-group-thread-function.test.js) rather than
// through the Edge Function, same "insert the fixture directly, test the
// thing this file is actually about" reasoning mark-thread-read-function.test.js
// documents for its own message fixtures.
//
// The one assertion that matters most: a free group message must never
// touch wallets or ledger_entries at all — that's the entire point of this
// function existing separately from the paid, still-kill-switched
// fn_send_group_message.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'send-group-message', 'index.ts');

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

async function callSendGroupMessage(token, body) {
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
  throw new Error('send-group-message function did not come up in time');
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

  const owner = await createTestUser();
  const member = await createTestUser();
  const outsider = await createTestUser();
  const tokenOwner = mintAccessToken(owner);
  const tokenMember = mintAccessToken(member);
  const tokenOutsider = mintAccessToken(outsider);
  let groupId;

  try {
    await waitForFunctionReady(15000);

    const created = await admin.query('select fn_create_group_thread($1, $2, $3) as id', [
      owner,
      'Test Group',
      [member],
    ]);
    groupId = created.rows[0].id;

    const noAuth = await callSendGroupMessage(null, { group_thread_id: groupId, body: 'hi' });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const emptyBody = await callSendGroupMessage(tokenOwner, {
      group_thread_id: groupId,
      body: '   ',
    });
    log(
      'blank body -> 400 empty_message',
      emptyBody.status === 400 && emptyBody.json?.error === 'empty_message',
      JSON.stringify(emptyBody.json),
    );

    const badGroup = await callSendGroupMessage(tokenOwner, {
      group_thread_id: crypto.randomUUID(),
      body: 'hello',
    });
    log(
      'nonexistent group -> 404 group_not_found',
      badGroup.status === 404 && badGroup.json?.error === 'group_not_found',
      JSON.stringify(badGroup.json),
    );

    const notMember = await callSendGroupMessage(tokenOutsider, {
      group_thread_id: groupId,
      body: 'i should not be able to post this',
    });
    log(
      'non-member -> 403 not_a_member',
      notMember.status === 403 && notMember.json?.error === 'not_a_member',
      JSON.stringify(notMember.json),
    );

    const sent = await callSendGroupMessage(tokenMember, {
      group_thread_id: groupId,
      body: 'hello from a real member',
    });
    log(
      'member sends a real message -> 200 with message_id/word_count',
      sent.status === 200 &&
        typeof sent.json?.message_id === 'string' &&
        sent.json?.word_count === 5,
      JSON.stringify(sent.json),
    );

    const msgRow = (
      await admin.query(
        'select credits_charged, owner_earning_credits, platform_take_credits, sender_id from group_messages where id = $1',
        [sent.json.message_id],
      )
    ).rows[0];
    log(
      'the stored message is genuinely free (all three money columns are 0)',
      msgRow.credits_charged === '0' &&
        msgRow.owner_earning_credits === '0' &&
        msgRow.platform_take_credits === '0',
      JSON.stringify(msgRow),
    );
    log(
      'sender_id is the real member, not spoofable from the request body',
      msgRow.sender_id === member,
    );

    const ledgerCount = (
      await admin.query(
        `select count(*)::int as n from ledger_entries where ref_type = 'group_message' and ref_id = $1`,
        [sent.json.message_id],
      )
    ).rows[0].n;
    log(
      'ZERO ledger_entries rows exist for this message (no money touched at all)',
      ledgerCount === 0,
      `n=${ledgerCount}`,
    );

    // client_message_id idempotency (docs/13-OFFLINE-MODE-SCOPING.md) — the
    // offline outbox retries a queued group send too; a retry must never
    // insert a duplicate message. Sequential retry first, then the
    // concurrency case (no row lock backs this path, so the insert itself
    // is wrapped in an exception handler — this proves that actually works).
    const clientMessageId1 = crypto.randomUUID();
    const first = await callSendGroupMessage(tokenMember, {
      group_thread_id: groupId,
      body: 'idempotency check one',
      client_message_id: clientMessageId1,
    });
    const retry = await callSendGroupMessage(tokenMember, {
      group_thread_id: groupId,
      body: 'idempotency check one',
      client_message_id: clientMessageId1,
    });
    log(
      'sequential retry with the same client_message_id returns the original message_id',
      first.status === 200 &&
        retry.status === 200 &&
        retry.json?.message_id === first.json?.message_id,
      JSON.stringify({ first: first.json, retry: retry.json }),
    );

    const dupCount = (
      await admin.query(
        'select count(*)::int as n from group_messages where client_message_id = $1',
        [clientMessageId1],
      )
    ).rows[0].n;
    log(
      'exactly one group_messages row exists for the retried client_message_id',
      dupCount === 1,
      `n=${dupCount}`,
    );

    const clientMessageId2 = crypto.randomUUID();
    const [concurrentA, concurrentB] = await Promise.all([
      callSendGroupMessage(tokenMember, {
        group_thread_id: groupId,
        body: 'idempotency check two',
        client_message_id: clientMessageId2,
      }),
      callSendGroupMessage(tokenMember, {
        group_thread_id: groupId,
        body: 'idempotency check two',
        client_message_id: clientMessageId2,
      }),
    ]);
    log(
      'both concurrent calls with the same client_message_id succeed and agree on message_id',
      concurrentA.status === 200 &&
        concurrentB.status === 200 &&
        concurrentA.json?.message_id === concurrentB.json?.message_id,
      `a=${JSON.stringify(concurrentA.json)} b=${JSON.stringify(concurrentB.json)}`,
    );

    const dupCount2 = (
      await admin.query(
        'select count(*)::int as n from group_messages where client_message_id = $1',
        [clientMessageId2],
      )
    ).rows[0].n;
    log(
      'exactly one group_messages row exists for the concurrently-retried client_message_id',
      dupCount2 === 1,
      `n=${dupCount2}`,
    );
  } finally {
    deno.kill();
    if (groupId) {
      await admin.query('delete from group_messages where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_members where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_threads where id = $1', [groupId]);
    }
    await deleteTestUser(owner);
    await deleteTestUser(member);
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
