#!/usr/bin/env node
// End-to-end test of the transfer-credit Edge Function
// (supabase/functions/transfer-credit/) against the real linked dev
// database. See README.md for the deno-run-instead-of-functions-serve
// rationale. This one does mutate real balances (per CLAUDE.md's testing
// requirement for any function that touches a wallet), so cleanup mirrors
// wallet-functions.test.js's deleteTestUser rather than the plainer one in
// find-user-by-phone-function.test.js — concurrency/conservation properties
// of fn_transfer_credit itself are covered there; this file is the
// HTTP-layer contract (auth, validation, error mapping).

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'transfer-credit', 'index.ts');

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
  const user = await res.json();
  return { id: user.id, phone };
}

async function fundTopupCredit(admin, userId, credits) {
  const wallet = await admin.query(
    "select id from public.wallets where user_id = $1 and kind = 'topup_credit'",
    [userId],
  );
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.rows[0].id, credits],
  );
}

async function walletBalance(admin, userId, kind) {
  const r = await admin.query('select balance from public.wallets where user_id=$1 and kind=$2', [
    userId,
    kind,
  ]);
  return Number(r.rows[0].balance);
}

async function resetPlatformEarningsCutWallet(admin) {
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id is null and kind = 'platform_revenue_earnings_cut'
     )`,
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query(
    "update public.wallets set balance = 0 where user_id is null and kind = 'platform_revenue_earnings_cut'",
  );
}

async function deleteTestUser(admin, id) {
  admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id = $1
     )`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query(
    'delete from public.credit_transfers where sender_id = $1 or recipient_id = $1',
    [id],
  );
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function callTransferCredit(token, body) {
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
  throw new Error('transfer-credit function did not come up in time');
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
  const tokenA = mintAccessToken(A.id);

  try {
    await waitForFunctionReady(15000);

    // fn_transfer_credit now requires a Tier-1 recipient (session 13,
    // docs/06-SECURITY-FRAUD-LOOPHOLES.md §2) — B is Tier-1 for the rest
    // of this file so every test below still exercises what it originally
    // meant to (validation, caps, balance, split), not this new gate.
    // The gate itself gets its own dedicated test further down, against a
    // separate Tier-0 recipient.
    await admin.query('update public.users set kyc_tier = 1 where id = $1', [B.id]);

    const noAuth = await callTransferCredit(null, {
      recipient_phone: B.phone,
      credits: 10,
    });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const missingFields = await callTransferCredit(tokenA, {});
    log(
      'missing recipient_phone -> 400 invalid_request',
      missingFields.status === 400 && missingFields.json?.error === 'invalid_request',
      JSON.stringify(missingFields.json),
    );

    const badCredits = await callTransferCredit(tokenA, {
      recipient_phone: B.phone,
      credits: -5,
    });
    log(
      'negative credits -> 400 invalid_request',
      badCredits.status === 400 && badCredits.json?.error === 'invalid_request',
      JSON.stringify(badCredits.json),
    );

    const self = await callTransferCredit(tokenA, { recipient_phone: A.phone, credits: 10 });
    log(
      'transferring to self -> 400 invalid_request',
      self.status === 400 && self.json?.error === 'invalid_request',
      JSON.stringify(self.json),
    );

    const notFound = await callTransferCredit(tokenA, {
      recipient_phone: '+2340000000000',
      credits: 10,
    });
    log(
      'unregistered recipient -> 404 user_not_found',
      notFound.status === 404 && notFound.json?.error === 'user_not_found',
      JSON.stringify(notFound.json),
    );

    const broke = await callTransferCredit(tokenA, { recipient_phone: B.phone, credits: 10 });
    log(
      'sender with zero balance -> 402 insufficient_credit',
      broke.status === 402 && broke.json?.error === 'insufficient_credit',
      JSON.stringify(broke.json),
    );

    const overCap = await callTransferCredit(tokenA, {
      recipient_phone: B.phone,
      credits: 100000,
    });
    log(
      'amount over the per-transfer cap -> 400 amount_over_transfer_cap',
      overCap.status === 400 && overCap.json?.error === 'amount_over_transfer_cap',
      JSON.stringify(overCap.json),
    );

    await fundTopupCredit(admin, A.id, 100);
    const ok = await callTransferCredit(tokenA, {
      recipient_phone: B.phone,
      credits: 100,
      note: 'for lunch',
    });
    log(
      'a funded, valid transfer -> 200 with the split amounts',
      ok.status === 200 &&
        typeof ok.json?.transfer_id === 'string' &&
        ok.json?.credits_sent === 100 &&
        ok.json?.credits_received === 100 - ok.json?.platform_cut_credits,
      JSON.stringify(ok.json),
    );

    const aBalance = await walletBalance(admin, A.id, 'topup_credit');
    log("sender's topup_credit reflects the debit", aBalance === 0, `balance=${aBalance}`);

    const bCash = await walletBalance(admin, B.id, 'withdrawable_cash');
    log(
      "recipient's withdrawable_cash increased (credit landed as spendable cash, not just chat credit)",
      bCash > 0,
      `balance=${bCash}`,
    );

    // The KYC gate itself (session 13) — a fresh, still-Tier-0 recipient.
    const C = await createTestUser();
    await fundTopupCredit(admin, A.id, 100);
    const unverifiedRecipient = await callTransferCredit(tokenA, {
      recipient_phone: C.phone,
      credits: 10,
    });
    log(
      'a Tier-0 (unverified) recipient -> 403 recipient_kyc_required',
      unverifiedRecipient.status === 403 &&
        unverifiedRecipient.json?.error === 'recipient_kyc_required',
      JSON.stringify(unverifiedRecipient.json),
    );
    await deleteTestUser(admin, C.id);
  } finally {
    deno.kill();
    await resetPlatformEarningsCutWallet(admin);
    await deleteTestUser(admin, A.id);
    await deleteTestUser(admin, B.id);
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
