#!/usr/bin/env node
// Phase 2 batch 2 — end-to-end test of the webhook-flutterwave Edge
// Function. Real HTTP calls with real HMAC-SHA256 signatures computed the
// same way packages/payments/flutterwave.ts's verifyWebhook checks them,
// against the real dev database. See supabase/tests/README.md for the
// deno-run-instead-of-functions-serve rationale.
//
// The exact event payload shape/type strings are Flutterwave's documented
// v4 webhook convention as far as could be confirmed without a live
// account (see packages/payments/flutterwave.ts's header comment) — this
// test exercises this project's own handling of that shape, not a
// guarantee a real Flutterwave webhook looks exactly like this.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Synthetic secret if .env doesn't have a real one yet — signature
// verification only needs *a* shared secret to exercise correctly, not a
// real Flutterwave-issued one (per docs/00-SESSION-HANDOFF.md's original
// batch 2 plan).
const WEBHOOK_SECRET = process.env.FLW_WEBHOOK_SECRET_HASH || 'test-webhook-secret';

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'webhook-flutterwave', 'index.ts');

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

function sign(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
}

async function postWebhook(payloadObj, { signature } = {}) {
  const rawBody = JSON.stringify(payloadObj);
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== null) {
    headers['flutterwave-signature'] = signature !== undefined ? signature : sign(rawBody);
  }
  const res = await fetch(`${FUNCTION_URL}/`, { method: 'POST', headers, body: rawBody });
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
  throw new Error('webhook-flutterwave function did not come up in time');
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

async function resetPlatformWallets(admin) {
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id is null
         and kind in ('platform_revenue_topup_fees','platform_revenue_earnings_cut')
     )`,
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query(
    "update public.wallets set balance = 0 where user_id is null and kind in ('platform_revenue_topup_fees','platform_revenue_earnings_cut')",
  );
}

async function deleteWebhookEvent(admin, eventId) {
  await admin.query('delete from public.webhook_events_seen where provider_event_id = $1', [
    eventId,
  ]);
}

// =============================================================================
// Test 1: charge.completed confirms a real topup fixture (created via
// fn_buy_credit directly — that DB function isn't deferred, only the
// Edge Function wrapper that would call Flutterwave to create the charge
// in the first place), and a replay of the identical event is a no-op.
// =============================================================================

async function testChargeCompletedConfirmsTopup(admin) {
  const A = await createTestUser();

  const topupRes = await admin.query('select public.fn_buy_credit($1, 100000, $2) as id', [
    A,
    'flutterwave',
  ]);
  const topupId = topupRes.rows[0].id;
  const eventId = `wbk_test_${crypto.randomUUID()}`;

  const payload = {
    id: eventId,
    type: 'charge.completed',
    data: { id: `chg_test_${crypto.randomUUID()}`, reference: topupId },
  };

  const first = await postWebhook(payload);
  log(
    'first delivery of a valid, signed charge.completed webhook -> 200 processed',
    first.status === 200 && first.json?.status === 'processed',
    JSON.stringify(first.json),
  );

  const topupAfter = await admin.query('select status from public.topups where id = $1', [topupId]);
  log(
    'topup is marked completed',
    topupAfter.rows[0]?.status === 'completed',
    JSON.stringify(topupAfter.rows[0]),
  );

  const wallet = await walletRow(admin, A, 'topup_credit');
  log(
    'credits were issued (98 credits on a ₦1000 topup)',
    Number(wallet.balance) === 98,
    `balance=${wallet.balance}`,
  );

  const sum = await ledgerSum(admin, wallet.id);
  log(
    'ledger conservation holds on topup_credit',
    sum === Number(wallet.balance),
    `sum=${sum} balance=${wallet.balance}`,
  );

  // Replay: identical event id, must not double-credit.
  const replay = await postWebhook(payload);
  log(
    'replaying the identical event -> 200 already_processed, not reprocessed',
    replay.status === 200 && replay.json?.status === 'already_processed',
    JSON.stringify(replay.json),
  );

  const walletAfterReplay = await walletRow(admin, A, 'topup_credit');
  log(
    'balance unchanged after replay (98, not 196)',
    Number(walletAfterReplay.balance) === 98,
    `balance=${walletAfterReplay.balance}`,
  );

  await deleteWebhookEvent(admin, eventId);
  await resetPlatformWallets(admin);
  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 2: signature verification — wrong signature, missing signature,
// and a tampered body against a signature computed for the original body
// (proves the check is over the actual bytes received, not just present).
// =============================================================================

async function testSignatureVerification(admin) {
  const A = await createTestUser();
  const topupRes = await admin.query('select public.fn_buy_credit($1, 100000, $2) as id', [
    A,
    'flutterwave',
  ]);
  const topupId = topupRes.rows[0].id;
  const eventId = `wbk_test_${crypto.randomUUID()}`;
  const payload = {
    id: eventId,
    type: 'charge.completed',
    data: { id: `chg_test_${crypto.randomUUID()}`, reference: topupId },
  };

  const noSig = await postWebhook(payload, { signature: null });
  log(
    'missing signature header -> 401 invalid_signature',
    noSig.status === 401 && noSig.json?.error === 'invalid_signature',
    JSON.stringify(noSig.json),
  );

  const wrongSig = await postWebhook(payload, { signature: 'deadbeef'.repeat(8) });
  log(
    'garbage signature -> 401 invalid_signature',
    wrongSig.status === 401 && wrongSig.json?.error === 'invalid_signature',
    JSON.stringify(wrongSig.json),
  );

  // A signature computed for a *different* body than what's actually sent.
  const rawBody = JSON.stringify(payload);
  const tamperedSignature = sign(rawBody);
  const tamperedBody = JSON.stringify({
    ...payload,
    data: { ...payload.data, reference: crypto.randomUUID() },
  });
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'flutterwave-signature': tamperedSignature },
    body: tamperedBody,
  });
  const tampered = { status: res.status, json: await res.json().catch(() => null) };
  log(
    "signature valid for a different body than what's sent -> 401 invalid_signature",
    tampered.status === 401 && tampered.json?.error === 'invalid_signature',
    JSON.stringify(tampered.json),
  );

  const topupAfter = await admin.query('select status from public.topups where id = $1', [topupId]);
  log(
    'none of the rejected requests touched the topup (still pending)',
    topupAfter.rows[0]?.status === 'pending',
    JSON.stringify(topupAfter.rows[0]),
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 3: transfer.completed / transfer.failed against real withdrawal
// fixtures created via fn_initiate_withdrawal directly (same fixture
// pattern wallet-functions.test.js and withdraw-function.test.js use).
// =============================================================================

async function testTransferWebhooksCompleteWithdrawals(admin) {
  const A = await createTestUser();
  await admin.query('update public.users set kyc_tier = 1 where id = $1', [A]);
  const bankRes = await admin.query(
    `insert into public.bank_accounts (user_id, bank_name, account_name, name_match_verified, provider_account_id)
     values ($1, 'Test Bank', 'Webhook Test', true, 'rcb_test') returning id`,
    [A],
  );
  const bankAccountId = bankRes.rows[0].id;

  const minKobo = (
    await admin.query("select value from public.pricing_config where key='withdrawal_min_kobo'")
  ).rows[0].value;

  // Fixture 1: will be completed.
  const wallet1 = await walletRow(admin, A, 'withdrawable_cash');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'earnings_conversion')`,
    [wallet1.id, Number(minKobo) * 2],
  );
  const w1 = await admin.query('select * from public.fn_initiate_withdrawal($1, $2, $3, $4)', [
    A,
    bankAccountId,
    Number(minKobo),
    false,
  ]);
  const withdrawal1Id = w1.rows[0].withdrawal_id;

  const completedEventId = `wbk_test_${crypto.randomUUID()}`;
  const completed = await postWebhook({
    id: completedEventId,
    type: 'transfer.completed',
    data: { id: `trf_test_${crypto.randomUUID()}`, reference: withdrawal1Id },
  });
  log(
    'transfer.completed -> 200 processed',
    completed.status === 200 && completed.json?.status === 'processed',
    JSON.stringify(completed.json),
  );

  const w1After = await admin.query('select status from public.withdrawals where id = $1', [
    withdrawal1Id,
  ]);
  log(
    "withdrawal marked 'paid'",
    w1After.rows[0]?.status === 'paid',
    JSON.stringify(w1After.rows[0]),
  );

  // Fixture 2: will fail — money should come back.
  const wallet2Before = await walletRow(admin, A, 'withdrawable_cash');
  const w2 = await admin.query('select * from public.fn_initiate_withdrawal($1, $2, $3, $4)', [
    A,
    bankAccountId,
    Number(minKobo),
    false,
  ]);
  const withdrawal2Id = w2.rows[0].withdrawal_id;
  const walletAfterInitiate = await walletRow(admin, A, 'withdrawable_cash');
  log(
    'second withdrawal debited the wallet',
    Number(walletAfterInitiate.balance) === Number(wallet2Before.balance) - Number(minKobo),
    `before=${wallet2Before.balance} after=${walletAfterInitiate.balance}`,
  );

  const failedEventId = `wbk_test_${crypto.randomUUID()}`;
  const failed = await postWebhook({
    id: failedEventId,
    type: 'transfer.failed',
    data: { id: `trf_test_${crypto.randomUUID()}`, reference: withdrawal2Id },
  });
  log(
    'transfer.failed -> 200 processed',
    failed.status === 200 && failed.json?.status === 'processed',
    JSON.stringify(failed.json),
  );

  const w2After = await admin.query('select status from public.withdrawals where id = $1', [
    withdrawal2Id,
  ]);
  log(
    "failed withdrawal marked 'failed'",
    w2After.rows[0]?.status === 'failed',
    JSON.stringify(w2After.rows[0]),
  );

  const walletAfterFail = await walletRow(admin, A, 'withdrawable_cash');
  log(
    'the failed transfer was reversed — balance back to its pre-second-withdrawal value',
    Number(walletAfterFail.balance) === Number(wallet2Before.balance),
    `expected=${wallet2Before.balance} actual=${walletAfterFail.balance}`,
  );

  const sum = await ledgerSum(admin, wallet1.id);
  log(
    'ledger conservation holds across both withdrawals',
    sum === Number(walletAfterFail.balance),
    `sum=${sum} balance=${walletAfterFail.balance}`,
  );

  await deleteWebhookEvent(admin, completedEventId);
  await deleteWebhookEvent(admin, failedEventId);
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
      FLW_WEBHOOK_SECRET_HASH: WEBHOOK_SECRET,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  try {
    await waitForFunctionReady(15000);

    await testChargeCompletedConfirmsTopup(admin);
    await testSignatureVerification(admin);
    await testTransferWebhooksCompleteWithdrawals(admin);
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
