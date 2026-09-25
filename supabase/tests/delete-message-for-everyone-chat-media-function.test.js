#!/usr/bin/env node
// Chat-media half of delete-message-for-everyone
// (20260925120000_chat_media_pipeline.sql) — message-delete-function.test.js
// already covers the text-only behavior (body blanked, flag set, window
// enforcement); this suite is specifically about the new Storage cleanup:
// a deleted media message's real object must actually be gone from
// `chat-media`, not just unreferenced.

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
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function fundTopupCredit(admin, userId, credits) {
  const wallet = (
    await admin.query('select id from public.wallets where user_id=$1 and kind=$2', [
      userId,
      'topup_credit',
    ])
  ).rows[0];
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.id, credits],
  );
}

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMDAwMDAwMDAwMEAwMEBQQEBAQFBQUFBQUFBQYGBgYGBgYICAgICAgICAoKCgoKCgwMDAwMDg4ODg4ODg4ODg4BAwMDBAQEBQUFBQUFBQUFBQUFBQUFBQYFBQUFBQUGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYG/8AAEQgAAQABAwERAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAX/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF/9k=',
  'base64',
);

async function uploadFixtureImage(userId) {
  const objectPath = `${userId}/${crypto.randomUUID()}.jpg`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/chat-media/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'image/jpeg',
    },
    body: TINY_JPEG,
  });
  if (!res.ok) throw new Error(`uploadFixtureImage failed: ${res.status} ${await res.text()}`);
  return objectPath;
}

async function callFunction(token, body) {
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
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

async function spawnFunction(name) {
  const entry = path.join(__dirname, '..', 'functions', name, 'index.ts');
  const proc = spawn('deno', ['run', '-A', entry], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[deno:${name}] ${d}`));
  proc.stderr.on('data', (d) => process.stdout.write(`[deno:${name}] ${d}`));
  await waitForFunctionReady(15000);
  return proc;
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const A = await createTestUser();
  const B = await createTestUser();
  let threadId;

  try {
    await fundTopupCredit(admin, A, 20);
    const objectPath = await uploadFixtureImage(A);

    let deno = await spawnFunction('send-message');
    const sent = await callFunction(mintAccessToken(A), {
      recipient_id: B,
      body: '',
      media_path: objectPath,
      media_type: 'image',
    });
    threadId = sent.json?.thread_id;
    log('media message sends successfully', sent.status === 200, JSON.stringify(sent.json));
    deno.kill();

    const beforeDelete = await admin.query(
      "select count(*)::int as n from storage.objects where bucket_id = 'chat-media' and name = $1",
      [objectPath],
    );
    log('the Storage object exists before deletion', beforeDelete.rows[0].n === 1);

    deno = await spawnFunction('delete-message-for-everyone');
    const deleted = await callFunction(mintAccessToken(A), { message_id: sent.json.message_id });
    log(
      'delete-for-everyone succeeds on a media message',
      deleted.status === 200,
      JSON.stringify(deleted.json),
    );
    deno.kill();

    const row = await admin.query(
      'select body, deleted_for_everyone, media_path, media_type from public.messages where id = $1',
      [sent.json.message_id],
    );
    log(
      'the row is blanked: body empty, flag set, media_path/media_type cleared',
      row.rows[0].body === '' &&
        row.rows[0].deleted_for_everyone === true &&
        row.rows[0].media_path === null &&
        row.rows[0].media_type === null,
      JSON.stringify(row.rows[0]),
    );

    const afterDelete = await admin.query(
      "select count(*)::int as n from storage.objects where bucket_id = 'chat-media' and name = $1",
      [objectPath],
    );
    log(
      'the real Storage object is actually gone after delete-for-everyone',
      afterDelete.rows[0].n === 0,
      `n=${afterDelete.rows[0].n}`,
    );
  } finally {
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
