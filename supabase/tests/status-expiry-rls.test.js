#!/usr/bin/env node
// Regression test for 20260925100000_status_expiry_sweep.sql's RLS change:
// `status_updates_select_own` used to only check `user_id = auth.uid()`,
// so a poster's own status stayed visible forever, even after its 24h
// `expires_at` window passed — confirmed by reading that policy's original
// migration (20260912072749_rls_policies.sql) and the later visibility
// migration's own comment documenting the old behavior as deliberate at
// the time. Product direction is now symmetric with the
// visible-to-thread-partner policy (which already gated on `expires_at`):
// expired means gone, for the poster too.
//
// Same raw-PostgREST-request-with-a-minted-JWT approach as
// group-rls-recursion.test.js's own selectAs — not `@supabase/supabase-js`'s
// createClient, which eagerly needs a global WebSocket this CI's Node
// doesn't have. This is also the only test in the suite that actually
// exercises the *own*-status visibility path as the poster's real client
// would (expire-statuses-function.test.js and post-status-function.test.js
// both only ever touch status_updates via a service-role/superuser
// connection, which bypasses RLS entirely).

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

async function selectAs(userId, table, queryString) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${queryString}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${mintAccessToken(userId)}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      data: null,
      error: { message: json?.message ?? `HTTP ${res.status}`, code: json?.code },
    };
  }
  return { data: json, error: null };
}

async function createStatus(admin, userId, expiresInHours, caption) {
  const res = await admin.query(
    `insert into public.status_updates (user_id, caption, credits_charged, expires_at)
     values ($1, $2, 0, now() + make_interval(hours => $3))
     returning id`,
    [userId, caption, expiresInHours],
  );
  return res.rows[0].id;
}

async function deleteTestUser(admin, id) {
  await admin.query('delete from public.status_updates where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const poster = await createTestUser();
  let activeId, expiredId;

  try {
    // Still valid for 12 more hours.
    activeId = await createStatus(admin, poster, 12, 'still active');
    // Expired 1 hour ago.
    expiredId = await createStatus(admin, poster, -1, 'expired');

    const { data, error } = await selectAs(
      poster,
      'status_updates',
      'select=id,caption&order=created_at.asc',
    );
    log('poster query succeeds', !error, error ? JSON.stringify(error) : undefined);

    const ids = (data ?? []).map((r) => r.id);
    log('poster still sees their own active status', ids.includes(activeId));
    log('poster no longer sees their own expired status', !ids.includes(expiredId));
  } finally {
    if (poster) await deleteTestUser(admin, poster);
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
