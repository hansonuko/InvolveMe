#!/usr/bin/env node
// Regression test for the real, 9-day-live bug found in session 37:
// `20260918110000_profile_media_and_two_step.sql` did a blanket `revoke
// update on public.users from authenticated` and re-granted only a partial
// column list, silently dropping `last_seen_at`/`last_seen_enabled`
// (lib/lastSeen.ts's heartbeat), `read_receipts_enabled` (Settings >
// Privacy's toggle, lib/queries/profile.ts), and `terms_accepted_at`
// (the ToS/Privacy consent audit trail written on phone verification,
// app/(auth)/verify.tsx) — every one of these writes directly from the
// client via the anon key + a user JWT, with no Edge Function in the path,
// which is exactly why nothing in this suite (all Edge-Function/service-
// role based) ever caught it. Exercised here the same way
// chat-media-storage-rls.test.js/group-rls-recursion.test.js already do:
// real per-user JWTs against the real deployed PostgREST endpoint, which a
// service-role connection would bypass and prove nothing about.

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

async function patchUser(token, userId, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
    method: 'PATCH',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// Every column a real client screen updates directly (no Edge Function),
// with a value that round-trips cleanly for the assertion. Column list
// deliberately kept in sync with every `grant update (...) on public.users`
// statement across supabase/migrations — if a new one is added there and
// not here, this test won't catch it; if one is added here and the grant
// migration is missing, it will fail loudly, which is the point.
const SELF_WRITABLE_COLUMNS = [
  { column: 'display_name', value: 'Test Name' },
  { column: 'avatar_url', value: 'https://example.com/a.jpg' },
  { column: 'status_text', value: 'Testing' },
  { column: 'cover_url', value: 'https://example.com/c.jpg' },
  { column: 'links', value: ['https://example.com'] },
  { column: 'read_receipts_enabled', value: false },
  { column: 'terms_accepted_at', value: '2026-01-01T00:00:00.000Z' },
  { column: 'last_seen_at', value: '2026-01-01T00:00:00.000Z' },
  { column: 'last_seen_enabled', value: false },
];

async function testSelfWritableColumns(admin) {
  const userId = await createTestUser();
  const token = mintAccessToken(userId);

  try {
    for (const { column, value } of SELF_WRITABLE_COLUMNS) {
      const res = await patchUser(token, userId, { [column]: value });
      log(
        `a real user can update their own ${column} directly (no Edge Function) — this is the exact class of bug session 37 found: a later migration's blanket revoke silently dropped an earlier grant`,
        res.status === 200 || res.status === 204,
        `status=${res.status} body=${JSON.stringify(res.json)}`,
      );
    }

    // Negative control: a column that must stay service_role-only
    // regardless (docs/02, 20260912072749_rls_policies.sql's own comment)
    // — proves this test isn't just checking "any PATCH succeeds."
    const rejected = await patchUser(token, userId, { kyc_tier: 2 });
    log(
      'a real user CANNOT update kyc_tier directly — proves this test actually distinguishes granted from ungranted columns',
      rejected.status === 403 || rejected.status === 404,
      `status=${rejected.status} body=${JSON.stringify(rejected.json)}`,
    );
  } finally {
    await deleteTestUser(admin, userId);
  }
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await admin.connect();

  try {
    await testSelfWritableColumns(admin);
  } finally {
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e.message);
  process.exit(1);
});
