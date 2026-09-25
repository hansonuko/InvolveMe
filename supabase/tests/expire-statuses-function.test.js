#!/usr/bin/env node
// Test for the expire-statuses Edge Function
// (20260925100000_status_expiry_sweep.sql) — same X-Cron-Secret /
// raw-insert `auth.users` fixture pattern as remind-no-bank-account-
// function.test.js, safe here for the same reason: this function's auth
// is a shared cron secret, never a per-user JWT.
//
// What this deliberately does NOT cover: real Storage-object deletion
// against an actually-uploaded file — no test in this suite exercises real
// media upload (post-status-function.test.js doesn't either; a real
// upload needs create-status-upload-url's own signed-URL flow, out of
// scope for this function's own test). What's checked instead is that a
// `media_path` pointing at nothing (a plausible, non-crashing case —
// `storage.remove` on a key that doesn't exist is a documented no-error
// no-op) doesn't stop the row from being deleted, which is the actual
// contract this function needs to hold even when Storage cleanup can't do
// anything useful.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_INTERNAL_SECRET || 'test-cron-secret';

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'expire-statuses', 'index.ts');

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

async function callExpire({ secret } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (secret !== null) headers['X-Cron-Secret'] = secret !== undefined ? secret : CRON_SECRET;
  const res = await fetch(`${FUNCTION_URL}/`, { method: 'POST', headers, body: '{}' });
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
  throw new Error('expire-statuses function did not come up in time');
}

// Same raw-insert shortcut and rationale as remind-no-bank-account-
// function.test.js's createTestUser — this function never checks a
// per-user JWT.
async function createTestUser(admin) {
  const id = crypto.randomUUID();
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  await admin.query(
    `insert into auth.users (id, phone, created_at, aud, role, instance_id)
     values ($1, $2, now(), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`,
    [id, phone],
  );
  return id;
}

// `expiresInHours` is signed relative to now: negative -> expires_at is in
// the past (already expired, sweep-eligible), positive -> still in the
// future (must survive the sweep).
async function createStatus(admin, userId, { expiresInHours, mediaPath = null }) {
  const res = await admin.query(
    `insert into public.status_updates (user_id, caption, media_path, credits_charged, expires_at)
     values ($1, 'test status', $2, 0, now() + make_interval(hours => $3))
     returning id`,
    [userId, mediaPath, expiresInHours],
  );
  return res.rows[0].id;
}

async function statusExists(admin, id) {
  const res = await admin.query('select 1 from public.status_updates where id = $1', [id]);
  return res.rowCount > 0;
}

async function deleteTestUser(admin, id) {
  await admin.query('delete from public.status_updates where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
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
      CRON_INTERNAL_SECRET: CRON_SECRET,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  let userId;
  let expiredNoMedia, expiredWithMedia, notYetExpired;

  try {
    await waitForFunctionReady(15000);

    const noSecret = await callExpire({ secret: null });
    log('missing X-Cron-Secret -> 401', noSecret.status === 401, JSON.stringify(noSecret.json));

    const wrongSecret = await callExpire({ secret: 'definitely-not-it' });
    log('wrong X-Cron-Secret -> 401', wrongSecret.status === 401, JSON.stringify(wrongSecret.json));

    const getRes = await fetch(`${FUNCTION_URL}/`, {
      method: 'GET',
      headers: { 'X-Cron-Secret': CRON_SECRET },
    });
    log('GET -> 405', getRes.status === 405);

    userId = await createTestUser(admin);

    // Expired 1h ago (past the 24h window, docs/03-ECONOMY-LEDGER.md §7) —
    // eligible for the sweep.
    expiredNoMedia = await createStatus(admin, userId, { expiresInHours: -1 });
    // Same, but with a media_path pointing at nothing real — the
    // no-crash-on-a-missing-Storage-object contract this test is actually
    // here for.
    expiredWithMedia = await createStatus(admin, userId, {
      expiresInHours: -1,
      mediaPath: `status-media-test/${crypto.randomUUID()}.jpg`,
    });
    // Still expires 23h from now — well inside the 24h window, must
    // survive.
    notYetExpired = await createStatus(admin, userId, { expiresInHours: 23 });

    const result = await callExpire();
    log('expire call -> 200', result.status === 200, JSON.stringify(result.json));
    // >= not ===: this runs against the real shared dev database, which
    // can (and, the first time this ran, did) already have other
    // genuinely-expired statuses sitting in it from before this function
    // existed — the sweep correctly clears those too, this just can't
    // assert an exact count without owning the whole table.
    log(
      'reports at least the 2 fixtures as expired',
      (result.json?.expired ?? 0) >= 2,
      JSON.stringify(result.json),
    );

    log('expired status (no media) is deleted', !(await statusExists(admin, expiredNoMedia)));
    log(
      'expired status (missing media object) is still deleted',
      !(await statusExists(admin, expiredWithMedia)),
    );
    log('not-yet-expired status survives', await statusExists(admin, notYetExpired));

    // Idempotent re-run: nothing left to expire, no error.
    const second = await callExpire();
    log(
      'second call -> 200 with nothing left to expire',
      second.status === 200 && second.json?.expired === 0,
      JSON.stringify(second.json),
    );
  } finally {
    deno.kill();
    if (userId) await deleteTestUser(admin, userId);
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
