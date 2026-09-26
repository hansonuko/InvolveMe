#!/usr/bin/env node
// Regression test for chat_media_select_visible (RLS on storage.objects,
// 20260925120000_chat_media_pipeline.sql) — exercised via the real Storage
// REST API with real per-user JWTs, not a service-role connection (which
// bypasses RLS entirely and would prove nothing about this policy). Same
// motivation as group-rls-recursion.test.js and status-expiry-rls.test.js:
// this is the only test that actually exercises the read path a real
// client's own createSignedUrl call goes through.

const { Client } = require('pg');
const crypto = require('crypto');

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
    console.error(`${name} is not set. Run via \`node --env-file=.env\` from the repo root.`);
    process.exit(1);
  }
}

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
  await admin.query('delete from auth.users where id = $1', [id]);
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

/** Requests a signed read URL as a given user — the exact real-client read
 * path (createSignedUrl), RLS-enforced on storage.objects SELECT. */
async function requestSignedUrl(userId, objectPath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/chat-media/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${mintAccessToken(userId)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  return res.status;
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const A = await createTestUser(); // sender
  const B = await createTestUser(); // thread partner — should see it
  const C = await createTestUser(); // unrelated third party — should not
  let threadId;

  try {
    const objectPath = await uploadFixtureImage(A);

    // A real message referencing this path is what the RLS predicate
    // actually keys off — an uploaded-but-never-sent object has no
    // messages row pointing at it yet, so nobody but the uploader (via a
    // path they already know) could name it; the predicate itself is
    // what's under test here, exercised with a real row in place.
    const thread = await admin.query(
      // payer_id has no column default (docs/18 §C1) — must be set
      // explicitly on a direct insert or fn_send_message rejects every
      // send against this thread with no_active_payer.
      `insert into public.threads (participant_a, participant_b, payer_id) values ($1, $2, $1) returning id`,
      [A, B],
    );
    threadId = thread.rows[0].id;
    await admin.query(
      `insert into public.messages (thread_id, sender_id, body, word_count, credits_charged, status, media_path, media_type)
       values ($1, $2, '', 0, 6, 'escrowed', $3, 'image')`,
      [threadId, A, objectPath],
    );

    const statusA = await requestSignedUrl(A, objectPath);
    log(
      'the sender can request a signed read URL for their own upload',
      statusA === 200,
      `status=${statusA}`,
    );

    const statusB = await requestSignedUrl(B, objectPath);
    log('the thread partner can request a signed read URL', statusB === 200, `status=${statusB}`);

    const statusC = await requestSignedUrl(C, objectPath);
    log(
      'an unrelated third party cannot request a signed read URL',
      statusC !== 200,
      `status=${statusC}`,
    );
  } finally {
    if (threadId) {
      await admin.query('delete from public.messages where thread_id = $1', [threadId]);
      await admin.query('delete from public.threads where id = $1', [threadId]);
    }
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
