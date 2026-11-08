#!/usr/bin/env node
// End-to-end test of send-message's generic file/document attachment
// support (docs/16-CHAT-MEDIA-SCOPING.md §2's "its own scoping pass if
// wanted" follow-up, 20261011090000_chat_file_attachments.sql). Same
// real-HTTP-function/real-JWT approach as send-message-chat-media-
// function.test.js (this file's own sibling), split out as its own suite
// rather than bolted onto that one — same convention every other media
// kind already established with its own dedicated test file.
//
// Fixture uploads go straight through the Storage REST API using the
// service-role key (bypasses RLS/signed-URL-token requirements entirely,
// same net effect a signed upload completing normally would have) rather
// than also spawning create-chat-media-upload-url as a second Deno
// process on the same default port — this suite is about send-message's
// own media handling, not re-proving upload-url minting again
// (create-chat-media-upload-url-function.test.js already does that).

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

const TINY_PDF = Buffer.from('%PDF-1.4\n%%EOF', 'utf8');

/** Uploads directly via the Storage REST API using the service-role key —
 * bypasses RLS/signed-URL-token requirements entirely (same net effect a
 * real signed-upload-URL flow completing normally has), so this suite
 * doesn't need a second Deno process just to mint one. Path always
 * `${userId}/${uuid}.pdf`, matching create-chat-media-upload-url's own
 * real convention exactly — this is what fn_send_message's ownership
 * check validates against. */
async function uploadFixtureFile(userId) {
  const objectPath = `${userId}/${crypto.randomUUID()}.pdf`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/chat-media/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/pdf',
    },
    body: TINY_PDF,
  });
  if (!res.ok) throw new Error(`uploadFixtureFile failed: ${res.status} ${await res.text()}`);
  return objectPath;
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
  const fileCredits = await pricingValue(admin, 'message_file_credits');

  const cleanupUsers = [];
  const cleanupThreads = [];

  try {
    await waitForFunctionReady(15000);

    // ---------------------------------------------------------------------
    // Test 1: a captionless file is a real, valid message — base credits
    // (the word_count=0 floor) + the file surcharge, word_count stored as
    // 0, and the original filename is stored alongside the server-derived
    // path.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureFile(A);
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'file',
        media_filename: 'Invoice.pdf',
      });
      log(
        'captionless file message succeeds (HTTP 200)',
        result.status === 200,
        JSON.stringify(result.json),
      );
      log(
        `charges base + file surcharge (${baseCredits} + ${fileCredits} = ${baseCredits + fileCredits})`,
        result.json?.credits_charged === baseCredits + fileCredits,
        JSON.stringify(result.json),
      );
      log(
        'word_count is 0, not rejected',
        result.json?.word_count === 0,
        JSON.stringify(result.json),
      );

      const threadId = result.json.thread_id;
      cleanupThreads.push(threadId);
      const row = await admin.query(
        'select media_path, media_type, media_filename, body from public.messages where id = $1',
        [result.json.message_id],
      );
      log(
        'media_path/media_type/media_filename are actually stored on the row',
        row.rows[0].media_path === objectPath &&
          row.rows[0].media_type === 'file' &&
          row.rows[0].media_filename === 'Invoice.pdf',
        JSON.stringify(row.rows[0]),
      );

      const wallet = await walletRow(admin, A, 'topup_credit');
      const ok = (await ledgerSum(admin, wallet.id)) === Number(wallet.balance);
      log('ledger conservation holds after a file-only send', ok, `balance=${wallet.balance}`);
    }

    // ---------------------------------------------------------------------
    // Test 2: file + caption — additive, not a replacement for the
    // word-count formula.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureFile(A);
      const caption = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' '); // 60 words -> 2 blocks
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: caption,
        media_path: objectPath,
        media_type: 'file',
        media_filename: 'Report.docx',
      });
      const expectedTextCredits = baseCredits * 2; // 60 words = 2 blocks of 50
      log(
        `file + 60-word caption charges text (${expectedTextCredits}) + file (${fileCredits})`,
        result.json?.credits_charged === expectedTextCredits + fileCredits,
        JSON.stringify(result.json),
      );
      cleanupThreads.push(result.json.thread_id);
    }

    // ---------------------------------------------------------------------
    // Test 3: a path prefixed with someone ELSE's user id is rejected —
    // the same cross-account check image/audio attachments already get.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const bOwnedPath = `${B}/${crypto.randomUUID()}.pdf`; // never actually uploaded by A
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: bOwnedPath,
        media_type: 'file',
        media_filename: 'Invoice.pdf',
      });
      log(
        "a media_path prefixed with someone else's user id is rejected",
        result.status === 400 && result.json?.error === 'invalid_media_path',
        JSON.stringify(result.json),
      );

      const walletAfter = await walletRow(admin, A, 'topup_credit');
      log('the rejected attempt never charged anything', Number(walletAfter.balance) === 20);
    }

    // ---------------------------------------------------------------------
    // Test 4: a well-formed, correctly-owned path that was never actually
    // uploaded is rejected — same existence check image/audio already get.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const neverUploadedPath = `${A}/${crypto.randomUUID()}.pdf`;
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: neverUploadedPath,
        media_type: 'file',
        media_filename: 'Invoice.pdf',
      });
      log(
        'a correctly-owned path with no actual Storage object is rejected',
        result.status === 400 && result.json?.error === 'media_not_found',
        JSON.stringify(result.json),
      );
    }

    // ---------------------------------------------------------------------
    // Test 5: media_type: 'file' with no media_filename at all is
    // rejected fail-closed by the Edge Function's own shape check, before
    // ever reaching the billing RPC.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureFile(A);
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'file',
      });
      log(
        'a file attachment with no media_filename is rejected',
        result.status === 400 && result.json?.error === 'invalid_media_filename',
        JSON.stringify(result.json),
      );

      const walletAfter = await walletRow(admin, A, 'topup_credit');
      log('the rejected attempt never charged anything', Number(walletAfter.balance) === 20);
    }

    // ---------------------------------------------------------------------
    // Test 6: escrow release still works for a file message — B's reply
    // releases A's file-message escrow exactly like a text one.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      const tokenB = mintAccessToken(B);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureFile(A);
      const first = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'file',
        media_filename: 'Invoice.pdf',
      });
      const threadId = first.json.thread_id;
      cleanupThreads.push(threadId);

      const reply = await callSendMessage(tokenB, { thread_id: threadId, body: 'thanks!' });
      log(
        'B can reply to a file message (HTTP 200)',
        reply.status === 200,
        JSON.stringify(reply.json),
      );

      const msgs = await admin.query(
        'select status, media_path from public.messages where thread_id = $1 order by created_at',
        [threadId],
      );
      log(
        "A's file message escrow released once B replied",
        msgs.rows[0].status === 'released' && msgs.rows[0].media_path === objectPath,
        JSON.stringify(msgs.rows),
      );

      const bEarnings = await walletRow(admin, B, 'withdrawable_cash');
      log(
        'B actually earned from the file message',
        Number(bEarnings.balance) > 0,
        `balance=${bEarnings.balance}`,
      );
    }

    // ---------------------------------------------------------------------
    // Test 7: concurrency — the offline-outbox idempotency key still holds
    // for a file message (CLAUDE.md's required concurrency case).
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureFile(A);
      const clientMessageId = crypto.randomUUID();
      const [a, b] = await Promise.all([
        callSendMessage(tokenA, {
          recipient_id: B,
          body: '',
          media_path: objectPath,
          media_type: 'file',
          media_filename: 'Invoice.pdf',
          client_message_id: clientMessageId,
        }),
        callSendMessage(tokenA, {
          recipient_id: B,
          body: '',
          media_path: objectPath,
          media_type: 'file',
          media_filename: 'Invoice.pdf',
          client_message_id: clientMessageId,
        }),
      ]);
      log(
        'both concurrent calls with the same client_message_id succeed',
        a.status === 200 && b.status === 200,
        `a=${JSON.stringify(a.json)} b=${JSON.stringify(b.json)}`,
      );
      log(
        'both resolve to the same message_id, only charged once',
        a.json?.message_id === b.json?.message_id,
        `a=${a.json?.message_id} b=${b.json?.message_id}`,
      );

      const threadIdOrNull = a.json?.thread_id ?? b.json?.thread_id;
      if (threadIdOrNull) cleanupThreads.push(threadIdOrNull);

      const wallet = await walletRow(admin, A, 'topup_credit');
      log(
        `only charged once (20 - ${baseCredits + fileCredits} = ${20 - (baseCredits + fileCredits)})`,
        Number(wallet.balance) === 20 - (baseCredits + fileCredits),
        `balance=${wallet.balance}`,
      );
      const ok = (await ledgerSum(admin, wallet.id)) === Number(wallet.balance);
      log('ledger conservation holds after the concurrent file send', ok);
    }
  } finally {
    deno.kill();
    for (const threadId of cleanupThreads) {
      await deleteTestThread(admin, threadId).catch(() => {});
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
