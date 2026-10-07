#!/usr/bin/env node
// End-to-end test of send-message's free-status-reply support
// (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1,
// 20260926130000_free_status_reply_first_message.sql). Same real-HTTP-
// function/real-JWT approach as send-message-chat-media-function.test.js
// (this file's own sibling) — split out as its own suite, same convention
// every prior send-message extension already followed.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'send-message', 'index.ts');

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
  await admin.query('begin');
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id = $1
     )`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('commit');
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function createTestStatus(admin, userId, expiresInHours = 24) {
  const res = await admin.query(
    `insert into public.status_updates (user_id, caption, credits_charged, expires_at)
     values ($1, 'test status', 3, now() + make_interval(hours => $2)) returning id`,
    [userId, expiresInHours],
  );
  return res.rows[0].id;
}

async function deleteTestStatus(admin, statusId) {
  await admin.query('delete from public.status_updates where id = $1', [statusId]);
}

async function walletRow(admin, userId, kind) {
  const r = await admin.query(
    'select id, balance from public.wallets where user_id=$1 and kind=$2',
    [userId, kind],
  );
  return r.rows[0];
}

async function ledgerSum(admin, walletId) {
  const r = await admin.query(
    'select coalesce(sum(amount), 0) as sum from public.ledger_entries where wallet_id = $1',
    [walletId],
  );
  return Number(r.rows[0].sum);
}

async function pricingValue(admin, key) {
  const r = await admin.query(
    "select value from public.pricing_config where key = $1 and currency = 'NGN'",
    [key],
  );
  return Number(r.rows[0].value);
}

async function callSendMessage(token, body) {
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
  throw new Error('send-message function did not come up in time');
}

async function fundTopupCredit(admin, userId, credits) {
  const wallet = await walletRow(admin, userId, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.id, credits],
  );
  return wallet;
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
  deno.stderr.on('data', (d) => process.stdout.write(`[deno] ${d}`));

  const baseCredits = await pricingValue(admin, 'message_base_credits');

  const cleanupUsers = [];
  const cleanupThreads = [];
  const cleanupStatuses = [];

  try {
    await waitForFunctionReady(15000);

    // ---------------------------------------------------------------------
    // Test 1: A's first-ever message to B, replying to B's real status,
    // is genuinely free — 0 credits charged, status = 'sent', no escrow
    // row, ledger conservation holds (nothing moved at all).
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);
      const statusId = await createTestStatus(admin, B);
      cleanupStatuses.push(statusId);

      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: 'nice status!',
        reply_to_status_id: statusId,
      });
      log(
        'free status reply succeeds (HTTP 200)',
        result.status === 200,
        JSON.stringify(result.json),
      );
      log('charges 0 credits', result.json?.credits_charged === 0, JSON.stringify(result.json));
      log(
        "status is 'sent', not 'escrowed'",
        result.json?.status === 'sent',
        JSON.stringify(result.json),
      );

      const threadId = result.json.thread_id;
      cleanupThreads.push(threadId);

      const row = await admin.query(
        'select reply_to_status_id, status, credits_charged from public.messages where id = $1',
        [result.json.message_id],
      );
      log(
        'reply_to_status_id is stored on the row',
        row.rows[0].reply_to_status_id === statusId,
        JSON.stringify(row.rows[0]),
      );

      const escrowRow = await admin.query('select 1 from public.escrows where message_id = $1', [
        result.json.message_id,
      ]);
      log('no escrow row was ever created for the free message', escrowRow.rows.length === 0);

      const wallet = await walletRow(admin, A, 'topup_credit');
      log('A was not charged anything', Number(wallet.balance) === 20, `balance=${wallet.balance}`);
      const ok = (await ledgerSum(admin, wallet.id)) === Number(wallet.balance);
      log('ledger conservation holds after a free status reply', ok);
    }

    // ---------------------------------------------------------------------
    // Test 2: the exploit case — A's SECOND message in the same thread,
    // even with a fresh reply_to_status_id, is billed normally. This is
    // the actual loophole-closing assertion, not a nice-to-have.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);
      const status1 = await createTestStatus(admin, B);
      const status2 = await createTestStatus(admin, B);
      cleanupStatuses.push(status1, status2);

      const first = await callSendMessage(tokenA, {
        recipient_id: B,
        body: 'first',
        reply_to_status_id: status1,
      });
      const threadId = first.json.thread_id;
      cleanupThreads.push(threadId);
      log(
        'first message (free) succeeds',
        first.json?.credits_charged === 0,
        JSON.stringify(first.json),
      );

      const second = await callSendMessage(tokenA, {
        thread_id: threadId,
        body: 'second, also claiming a status reply',
        reply_to_status_id: status2,
      });
      log(
        'a second message in the same thread is billed normally, even with reply_to_status_id set',
        second.status === 200 && second.json?.credits_charged === baseCredits,
        JSON.stringify(second.json),
      );
      log(
        "the second message's status is 'escrowed', not 'sent'",
        second.json?.status === 'escrowed',
        JSON.stringify(second.json),
      );
    }

    // ---------------------------------------------------------------------
    // Test 3: attaching media to a first-message status reply forfeits
    // the free exemption — media keeps its own separate billing.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);
      const statusId = await createTestStatus(admin, B);
      cleanupStatuses.push(statusId);

      const mediaCredits = await pricingValue(admin, 'message_media_credits');
      // A captionless message still charges the base word-block floor
      // (word_count=0 -> max(word_blocks,1) block) on top of the media
      // surcharge — same pattern send-message-chat-media-function.test.js
      // already establishes for a captionless photo.
      const expectedCredits = baseCredits + mediaCredits;
      const objectPath = `${A}/${crypto.randomUUID()}.jpg`;
      const tinyJpeg = Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMDAwMDAwMDAwMEAwMEBQQEBAQFBQUFBQUFBQYGBgYGBgYICAgICAgICAoKCgoKCgwMDAwMDg4ODg4ODg4ODg4BAwMDBAQEBQUFBQUFBQUFBQUFBQUFBQYFBQUFBQUGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYG/8AAEQgAAQABAwERAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAX/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF/9k=',
        'base64',
      );
      await fetch(`${SUPABASE_URL}/storage/v1/object/chat-media/${objectPath}`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'image/jpeg',
        },
        body: tinyJpeg,
      });

      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'image',
        reply_to_status_id: statusId,
      });
      log(
        'a status reply carrying media is billed normally (base floor + media surcharge), not free',
        result.status === 200 && result.json?.credits_charged === expectedCredits,
        JSON.stringify(result.json),
      );
      cleanupThreads.push(result.json.thread_id);
    }

    // ---------------------------------------------------------------------
    // Test 4: a fabricated/wrong status id is rejected outright.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      const C = await createTestUser();
      cleanupUsers.push(A, B, C);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const fakeId = crypto.randomUUID();
      const notVisible = await callSendMessage(tokenA, {
        recipient_id: B,
        body: 'hi',
        reply_to_status_id: fakeId,
      });
      log(
        'a nonexistent status id is rejected',
        notVisible.status === 400 && notVisible.json?.error === 'invalid_status_reply_target',
        JSON.stringify(notVisible.json),
      );

      // A real status, but posted by a THIRD party C, not by the thread
      // partner B — must also be rejected (proves this isn't just an
      // existence check, it's a visibility-to-this-thread check).
      const cStatus = await createTestStatus(admin, C);
      cleanupStatuses.push(cStatus);
      const wrongPoster = await callSendMessage(tokenA, {
        recipient_id: B,
        body: 'hi',
        reply_to_status_id: cStatus,
      });
      log(
        "a real status from someone who isn't this thread's partner is rejected",
        wrongPoster.status === 400 && wrongPoster.json?.error === 'invalid_status_reply_target',
        JSON.stringify(wrongPoster.json),
      );

      const walletAfter = await walletRow(admin, A, 'topup_credit');
      log('neither rejected attempt charged anything', Number(walletAfter.balance) === 20);
    }

    // ---------------------------------------------------------------------
    // Test 5: an expired status is rejected too.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);
      const expiredStatus = await createTestStatus(admin, B, -1); // already expired
      cleanupStatuses.push(expiredStatus);

      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: 'hi',
        reply_to_status_id: expiredStatus,
      });
      log(
        'an expired status is rejected',
        result.status === 400 && result.json?.error === 'invalid_status_reply_target',
        JSON.stringify(result.json),
      );
    }

    // ---------------------------------------------------------------------
    // Test 6: B's free status-reply to A still releases A's own earlier,
    // real pending escrow — the free exemption doesn't disable the normal
    // reply/escrow-release mechanic for anyone else's real messages.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      const tokenB = mintAccessToken(B);
      await fundTopupCredit(admin, A, 20);

      const first = await callSendMessage(tokenA, { recipient_id: B, body: 'hello there' });
      const threadId = first.json.thread_id;
      cleanupThreads.push(threadId);
      log(
        "A's real first message escrows normally",
        first.json?.status === 'escrowed',
        JSON.stringify(first.json),
      );

      // A posts a status; B (who has never sent anything in this thread)
      // replies to it for free — this is also B's first message ever in
      // the thread, so it's a real "reply" (v_is_reply) that should still
      // release A's pending escrow from the message above.
      const aStatus = await createTestStatus(admin, A);
      cleanupStatuses.push(aStatus);
      const bReply = await callSendMessage(tokenB, {
        thread_id: threadId,
        body: 'nice one',
        reply_to_status_id: aStatus,
      });
      log(
        "B's free status reply succeeds",
        bReply.json?.credits_charged === 0,
        JSON.stringify(bReply.json),
      );

      const aMessage = await admin.query('select status from public.messages where id = $1', [
        first.json.message_id,
      ]);
      log(
        "A's earlier real message escrow was released by B's free reply",
        aMessage.rows[0].status === 'released',
        JSON.stringify(aMessage.rows[0]),
      );

      const bEarnings = await walletRow(admin, B, 'withdrawable_cash');
      log(
        "B earned from A's real message (not from B's own free one)",
        Number(bEarnings.balance) > 0,
      );
    }
  } finally {
    deno.kill();
    for (const threadId of cleanupThreads) {
      await deleteTestThread(admin, threadId).catch(() => {});
    }
    for (const statusId of cleanupStatuses) {
      await deleteTestStatus(admin, statusId).catch(() => {});
    }
    for (const id of cleanupUsers) {
      await deleteTestUser(admin, id).catch(() => {});
    }
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
