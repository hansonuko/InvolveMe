#!/usr/bin/env node
// Phase 2 batch 2 — end-to-end test of the withdraw Edge Function.
// See README.md for the deno-run-instead-of-functions-serve rationale
// (unchanged from send-message-function.test.js).
//
// initiatePayout now calls the REAL (live/production, see
// docs/00-SESSION-HANDOFF.md session-3) Flutterwave /transfers endpoint.
// The `insertBankAccount` fixture below uses a made-up
// `provider_account_id` ('rcb_test_1') rather than a real
// `/transfers/recipients` id — bank-account linking isn't built yet — so
// Flutterwave genuinely rejects every transfer here (unknown recipient),
// which is what's actually under test: the DB validation chain up to
// fn_initiate_withdrawal, AND the compensating fn_fail_withdrawal path on a
// real provider rejection, the safety-critical half of this function
// regardless of which recipient it's ever pointed at for real.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'withdraw', 'index.ts');

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

// Same disable-trigger/delete-ledger-entries sequence as
// wallet-functions.test.js and send-message-function.test.js — a funded
// wallet can't cascade-delete through auth.users otherwise (ledger_entries
// is append-only, CLAUDE.md rule #4).
async function deleteTestUser(admin, id) {
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from public.withdrawals where user_id = $1', [id]);
  await admin.query('delete from public.bank_accounts where user_id = $1', [id]);
  await admin.query('delete from public.topups where user_id = $1', [id]);
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
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
  const r = await admin.query('select value from public.pricing_config where key = $1', [key]);
  return Number(r.rows[0].value);
}

async function fundWithdrawableCash(admin, userId, amountKobo) {
  const wallet = await walletRow(admin, userId, 'withdrawable_cash');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'earnings_conversion')`,
    [wallet.id, amountKobo],
  );
}

async function insertBankAccount(
  admin,
  userId,
  { verified = true, providerAccountId = 'rcb_test_1' } = {},
) {
  const r = await admin.query(
    `insert into public.bank_accounts (user_id, bank_name, account_name, name_match_verified, provider_account_id)
     values ($1, 'Test Bank', 'Withdraw Test', $2, $3) returning id`,
    [userId, verified, providerAccountId],
  );
  return r.rows[0].id;
}

async function callWithdraw(token, body) {
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
  throw new Error('withdraw function did not come up in time');
}

// =============================================================================
// Test 1: DB validation chain + provider-failure compensating path. The
// stub provider always throws, so a fully valid request should still fail
// at the HTTP layer (503) while leaving the ledger exactly where it
// started — proving fn_fail_withdrawal actually gets called and actually
// reverses the debit, not just that it exists.
// =============================================================================

async function testProviderFailureReversesDebit(admin) {
  const minKobo = await pricingValue(admin, 'withdrawal_min_kobo');
  const fundedKobo = minKobo * 5;

  const A = await createTestUser();
  const token = mintAccessToken(A);
  await admin.query('update public.users set kyc_tier = 1 where id = $1', [A]);
  const bankAccountId = await insertBankAccount(admin, A);
  await fundWithdrawableCash(admin, A, fundedKobo);

  const walletBefore = await walletRow(admin, A, 'withdrawable_cash');
  log('wallet funded as expected before the call', Number(walletBefore.balance) === fundedKobo);

  const res = await callWithdraw(token, { bank_account_id: bankAccountId, amount_kobo: minKobo });

  log(
    'a fully valid request still fails cleanly (503) since the provider is stubbed',
    res.status === 503 && res.json?.error === 'payment_provider_unavailable',
    JSON.stringify(res.json),
  );

  const walletAfter = await walletRow(admin, A, 'withdrawable_cash');
  log(
    'the debit was fully reversed — balance back to its pre-call value',
    Number(walletAfter.balance) === fundedKobo,
    `before=${fundedKobo} after=${walletAfter.balance}`,
  );

  const sum = await ledgerSum(admin, walletBefore.id);
  log(
    'ledger conservation holds after initiate+fail',
    sum === Number(walletAfter.balance),
    `ledger_sum=${sum} balance=${walletAfter.balance}`,
  );

  const w = await admin.query(
    'select status from public.withdrawals where user_id = $1 order by created_at desc limit 1',
    [A],
  );
  log(
    "the withdrawal row itself is marked 'failed', not left dangling in 'processing'",
    w.rows[0]?.status === 'failed',
    JSON.stringify(w.rows[0]),
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 2: error mapping — auth, validation, and every DB-level rejection
// reachable without a working provider.
// =============================================================================

async function testErrorMapping(admin) {
  const minKobo = await pricingValue(admin, 'withdrawal_min_kobo');

  const A = await createTestUser(); // kyc_tier 0, no bank account — default state
  const tokenA = mintAccessToken(A);

  const noAuth = await callWithdraw(null, {
    bank_account_id: crypto.randomUUID(),
    amount_kobo: minKobo,
  });
  log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

  const badUuid = await callWithdraw(tokenA, {
    bank_account_id: 'not-a-uuid',
    amount_kobo: minKobo,
  });
  log(
    'non-UUID bank_account_id -> 400 invalid_request',
    badUuid.status === 400 && badUuid.json?.error === 'invalid_request',
    JSON.stringify(badUuid.json),
  );

  const badAmount = await callWithdraw(tokenA, {
    bank_account_id: crypto.randomUUID(),
    amount_kobo: -5,
  });
  log(
    'negative amount_kobo -> 400 invalid_request',
    badAmount.status === 400 && badAmount.json?.error === 'invalid_request',
    JSON.stringify(badAmount.json),
  );

  const noSuchAccount = await callWithdraw(tokenA, {
    bank_account_id: crypto.randomUUID(),
    amount_kobo: minKobo,
  });
  log(
    'nonexistent bank_account_id -> 403 bank_account_unverified',
    noSuchAccount.status === 403 && noSuchAccount.json?.error === 'bank_account_unverified',
    JSON.stringify(noSuchAccount.json),
  );

  const unlinkedBankAccountId = await insertBankAccount(admin, A, {
    verified: true,
    providerAccountId: null,
  });
  const unlinked = await callWithdraw(tokenA, {
    bank_account_id: unlinkedBankAccountId,
    amount_kobo: minKobo,
  });
  log(
    'verified but provider-unlinked bank account -> 403 bank_account_unverified (caught before any debit)',
    unlinked.status === 403 && unlinked.json?.error === 'bank_account_unverified',
    JSON.stringify(unlinked.json),
  );

  // A has kyc_tier 0 (default) but now gets a fully linked bank account —
  // this exercises fn_initiate_withdrawal's own kyc check, past the
  // Edge Function's pre-check.
  const linkedBankAccountId = await insertBankAccount(admin, A);
  await fundWithdrawableCash(admin, A, minKobo * 5);
  const noKyc = await callWithdraw(tokenA, {
    bank_account_id: linkedBankAccountId,
    amount_kobo: minKobo,
  });
  log(
    'kyc_tier 0 with an otherwise-valid bank account -> 403 kyc_required',
    noKyc.status === 403 && noKyc.json?.error === 'kyc_required',
    JSON.stringify(noKyc.json),
  );

  await admin.query('update public.users set kyc_tier = 1 where id = $1', [A]);
  const belowMin = await callWithdraw(tokenA, {
    bank_account_id: linkedBankAccountId,
    amount_kobo: Math.max(1, minKobo - 1),
  });
  log(
    'amount below withdrawal_min_kobo -> 403 below_minimum',
    belowMin.status === 403 && belowMin.json?.error === 'below_minimum',
    JSON.stringify(belowMin.json),
  );

  await deleteTestUser(admin, A);
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
      FLW_WEBHOOK_SECRET_HASH: process.env.FLW_WEBHOOK_SECRET_HASH ?? 'test-secret',
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  try {
    await waitForFunctionReady(15000);

    await testProviderFailureReversesDebit(admin);
    await testErrorMapping(admin);
  } finally {
    deno.kill();
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
