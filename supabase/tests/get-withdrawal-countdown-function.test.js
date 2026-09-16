#!/usr/bin/env node
// Test for get-withdrawal-countdown (Phase 6,
// 20260916091500_fn_get_withdrawal_countdown.sql) — wraps the same
// fn_is_withdrawal_trusted trust-tier distinction fraud-functions.test.js
// already exercises for fn_run_auto_withdraw_sweep, just asserting the
// read-only wrapper's HTTP shape here. Users are created via the Admin API
// (see createAgedUser's own comment for why, not fraud-functions.test.js's
// raw-insert shortcut) and then backdated via a direct public.users update.

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
const FUNCTION_ENTRY = path.join(
  __dirname,
  '..',
  'functions',
  'get-withdrawal-countdown',
  'index.ts',
);

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

// Created via the Admin API (guarantees a GoTrue-valid user, same as every
// other function.test.js in this suite that actually verifies a token
// through requireAuthenticatedUser's real client.auth.getUser() call) —
// NOT fraud-functions.test.js's createAgedUser, which raw-inserts into
// auth.users directly. That shortcut works fine there because that suite
// only ever calls SQL functions through the admin connection and never
// exercises an Edge Function's real GoTrue-backed auth check; tried here
// first and it minted tokens GoTrue rejected as "Invalid or expired" even
// though the JWT itself was validly signed — the raw-inserted row is
// missing something GoTrue's own /auth/v1/user lookup needs (most likely
// one of the token columns Supabase's own well-known NULL-vs-''-string
// gotcha affects). fn_is_withdrawal_trusted only reads public.users.
// created_at (not auth.users.created_at), so backdating just that column
// after a normal Admin-API signup is sufficient and sidesteps the issue
// entirely.
async function createAgedUser(ageDays, kycTier) {
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
  if (!res.ok) throw new Error(`createAgedUser failed: ${res.status} ${await res.text()}`);
  const user = await res.json();
  return user.id;
}

async function backdateUser(admin, id, ageDays, kycTier) {
  await admin.query(
    'update public.users set created_at = now() - make_interval(days => $2), kyc_tier = $3 where id = $1',
    [id, ageDays, kycTier],
  );
}

async function deleteTestUser(admin, id) {
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function callGetWithdrawalCountdown(token) {
  const headers = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, { method: 'GET', headers });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${FUNCTION_URL}/`, { method: 'GET' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('get-withdrawal-countdown function did not come up in time');
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

  let freshTier1, oldClean, oldFlagged;

  try {
    await waitForFunctionReady(15000);

    const cfg = await admin.query(
      `select key, value from public.pricing_config
       where key in ('withdrawal_auto_sweep_hours', 'withdrawal_auto_sweep_hours_untrusted', 'new_account_age_days')`,
    );
    const cfgMap = Object.fromEntries(cfg.rows.map((r) => [r.key, Number(r.value)]));

    const noAuth = await callGetWithdrawalCountdown(null);
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    // Fresh Tier-1 account (younger than new_account_age_days) -> untrusted.
    freshTier1 = await createAgedUser(1, 1);
    await backdateUser(admin, freshTier1, 1, 1);
    const cdFresh = await callGetWithdrawalCountdown(mintAccessToken(freshTier1));
    log(
      'a fresh Tier-1 account is untrusted -> withdrawal_auto_sweep_hours_untrusted, force_sweep_below_minimum=false',
      cdFresh.status === 200 &&
        cdFresh.json?.effective_sweep_hours === cfgMap['withdrawal_auto_sweep_hours_untrusted'] &&
        cdFresh.json?.force_sweep_below_minimum === false,
      JSON.stringify(cdFresh.json),
    );

    // Old, clean Tier-1 account (older than new_account_age_days, no fraud
    // signal) -> trusted.
    oldClean = await createAgedUser(cfgMap['new_account_age_days'] + 30, 1);
    await backdateUser(admin, oldClean, cfgMap['new_account_age_days'] + 30, 1);
    const cdTrusted = await callGetWithdrawalCountdown(mintAccessToken(oldClean));
    log(
      'an old, clean Tier-1 account is trusted -> withdrawal_auto_sweep_hours, force_sweep_below_minimum=true',
      cdTrusted.status === 200 &&
        cdTrusted.json?.effective_sweep_hours === cfgMap['withdrawal_auto_sweep_hours'] &&
        cdTrusted.json?.force_sweep_below_minimum === true,
      JSON.stringify(cdTrusted.json),
    );

    // Old account, but a recent high-severity fraud signal -> untrusted
    // despite the age otherwise qualifying.
    oldFlagged = await createAgedUser(cfgMap['new_account_age_days'] + 30, 1);
    await backdateUser(admin, oldFlagged, cfgMap['new_account_age_days'] + 30, 1);
    await admin.query(
      `insert into public.fraud_signals (user_id, signal_type, severity, metadata) values ($1, 'test_signal', 'high', '{}'::jsonb)`,
      [oldFlagged],
    );
    const cdFlagged = await callGetWithdrawalCountdown(mintAccessToken(oldFlagged));
    log(
      'an old account with a recent high-severity fraud signal is untrusted despite its age',
      cdFlagged.status === 200 &&
        cdFlagged.json?.effective_sweep_hours === cfgMap['withdrawal_auto_sweep_hours_untrusted'] &&
        cdFlagged.json?.force_sweep_below_minimum === false,
      JSON.stringify(cdFlagged.json),
    );
  } finally {
    deno.kill();
    if (freshTier1) await deleteTestUser(admin, freshTier1);
    if (oldClean) await deleteTestUser(admin, oldClean);
    if (oldFlagged) await deleteTestUser(admin, oldFlagged);
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
