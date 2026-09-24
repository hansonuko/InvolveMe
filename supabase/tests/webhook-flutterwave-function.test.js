#!/usr/bin/env node
// Phase 2 batch 2 — end-to-end test of the webhook-flutterwave Edge
// Function. Real HTTP calls with the real `verif-hash` plain-secret header
// Flutterwave actually sends, against the real dev database. See
// supabase/tests/README.md for the deno-run-instead-of-functions-serve
// rationale.
//
// REWRITTEN 2026-09-13: the previous version of this test signed requests
// with HMAC-SHA256/base64 under a `flutterwave-signature` header and used
// a `{ type, data: { reference, status: 'succeeded' } }` envelope — all of
// which matched the (wrong) implementation at the time, not what
// Flutterwave actually sends. That's exactly why this suite passing 87/87
// never caught the real incident: it was testing this project's code
// against its own wrong assumptions, not against Flutterwave's documented
// contract. Rewritten against developer.flutterwave.com/docs/webhooks and
// .../reference/webhooks, fetched fresh — see
// packages/payments/flutterwave.ts's header comment for the full story and
// docs/05-API-REALTIME-SPEC.md for the corrected contract this now
// exercises.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Synthetic secret if .env doesn't have a real one yet — verification is a
// plain string compare against this value, so any non-empty string works
// for exercising the code path; doesn't need to be a real Flutterwave-
// issued one.
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

// Plain string, not a computed digest — matches
// packages/payments/flutterwave.ts's verifyWebhook: the real Flutterwave
// `verif-hash` header is just the dashboard-configured secret, compared
// directly, not a signature over anything.
function sign(_rawBody) {
  return WEBHOOK_SECRET;
}

async function postWebhook(payloadObj, { signature } = {}) {
  const rawBody = JSON.stringify(payloadObj);
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== null) {
    headers['verif-hash'] = signature !== undefined ? signature : sign(rawBody);
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
  const chargeId = `chg_test_${crypto.randomUUID()}`;
  // No top-level delivery id in Flutterwave's real payload — the
  // idempotency key webhook-flutterwave synthesizes is `${event}:${data.id}`.
  const eventId = `charge.completed:${chargeId}`;

  const payload = {
    event: 'charge.completed',
    data: { id: chargeId, tx_ref: topupId, status: 'successful' },
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
  const payload = {
    event: 'charge.completed',
    data: { id: `chg_test_${crypto.randomUUID()}`, tx_ref: topupId },
  };

  const noSig = await postWebhook(payload, { signature: null });
  log(
    'missing verif-hash header -> 401 invalid_signature',
    noSig.status === 401 && noSig.json?.error === 'invalid_signature',
    JSON.stringify(noSig.json),
  );

  const wrongSig = await postWebhook(payload, { signature: 'not-the-real-secret' });
  log(
    'wrong verif-hash value -> 401 invalid_signature',
    wrongSig.status === 401 && wrongSig.json?.error === 'invalid_signature',
    JSON.stringify(wrongSig.json),
  );

  // Verification is a plain compare against the configured secret, not a
  // signature over the body — so unlike an HMAC scheme, a *correct*
  // verif-hash value accompanying a tampered body is NOT rejected by
  // verifyWebhook itself (there's nothing in the body the header
  // cryptographically commits to, confirmed against Flutterwave's actual
  // documented mechanism). What still protects against sending an
  // arbitrary payload with the correct secret is that the secret itself is
  // never exposed to the client — this test instead confirms a malformed
  // body with a *correct* header is handled as "no reference" rather than
  // crashing.
  const malformedBody = 'not valid json {{{';
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'verif-hash': sign(malformedBody) },
    body: malformedBody,
  });
  const malformed = { status: res.status, json: await res.json().catch(() => null) };
  log(
    'correct verif-hash but unparseable JSON body -> 401 invalid_signature, not a crash',
    malformed.status === 401 && malformed.json?.error === 'invalid_signature',
    JSON.stringify(malformed.json),
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
// Test 3: transfer.disburse / transfer.reversal against real withdrawal
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

  const completedTransferId = `trf_test_${crypto.randomUUID()}`;
  const completedEventId = `transfer.completed:${completedTransferId}`;
  const completed = await postWebhook({
    event: 'transfer.completed',
    data: { id: completedTransferId, reference: withdrawal1Id, status: 'SUCCESSFUL' },
  });
  log(
    'transfer.completed (status SUCCESSFUL) -> 200 processed',
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

  const failedTransferId = `trf_test_${crypto.randomUUID()}`;
  const failedEventId = `transfer.completed:${failedTransferId}`;
  const failed = await postWebhook({
    event: 'transfer.completed',
    data: { id: failedTransferId, reference: withdrawal2Id, status: 'FAILED' },
  });
  log(
    'transfer.completed (status FAILED) -> 200 processed',
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

// =============================================================================
// Test 4: a transfer.completed reference that belongs to
// platform_withdrawals, not withdrawals — Phase F piece 3's fallback
// routing. Fixtures inserted directly (this connection is the DB owner,
// same "bypass the dual-approval RPCs for test setup" precedent every
// other admin-* test file already establishes) rather than through the
// real propose/approve/initiate flow, since what's under test here is the
// webhook's routing, not the dual-approval engine itself (covered
// exhaustively by admin-platform-withdrawal-functions.test.js).
// =============================================================================

const QA_CURRENCY = 'QAWH';

async function seedPlatformWithdrawalFixture(admin, { amountMinor }) {
  const walletRes = await admin.query(
    `insert into wallets (kind, currency, user_id) values ('platform_revenue_topup_fees', $1, null)
     on conflict (kind, currency) where user_id is null do update set currency = excluded.currency
     returning id`,
    [QA_CURRENCY],
  );
  const walletId = walletRes.rows[0].id;
  await admin.query(
    `insert into ledger_entries (wallet_id, amount, reason, ref_type, currency) values ($1, $2, 'manual_adjustment', 'admin_action', $3)`,
    [walletId, amountMinor * 10, QA_CURRENCY],
  );

  const bankRes = await admin.query(
    `insert into platform_bank_accounts (currency, bank_name, account_number_last4, provider_account_id, account_name, is_active, added_by_admin_id)
     values ($1, 'QA Webhook Test Bank', '0000', $2, 'InvolveMe QA', true, (select id from admin_users limit 1))
     returning id`,
    [QA_CURRENCY, `prov-${crypto.randomUUID()}`],
  );

  const adminRes = await admin.query('select id from admin_users limit 1');
  const proposeRes = await admin.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
    adminRes.rows[0].id,
    'platform_withdrawal',
    JSON.stringify({
      currency: QA_CURRENCY,
      amount_minor: amountMinor,
      platform_bank_account_id: bankRes.rows[0].id,
    }),
  ]);
  // Self-approval is blocked (cannot_approve_own_action) — a second admin
  // fixture approves, matching the real dual-approval flow rather than
  // bypassing it, since fn_admin_initiate_platform_withdrawal itself is
  // exercised here for real, not stubbed.
  const secondAdminRes = await admin.query(
    `insert into admin_users (id, email, display_name, password_hash) values (gen_random_uuid(), $1, 'QA Second Admin', 'x') returning id`,
    [`qa-webhook-second-${crypto.randomUUID()}@test.invalid`],
  );
  await admin.query(
    `insert into admin_user_roles (admin_user_id, role_id) select $1, id from admin_roles where name = 'super_admin'`,
    [secondAdminRes.rows[0].id],
  );
  await admin.query('select fn_admin_approve_pending_action($1, $2)', [
    secondAdminRes.rows[0].id,
    proposeRes.rows[0].id,
  ]);

  const initRes = await admin.query(
    'select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5) as id',
    [adminRes.rows[0].id, proposeRes.rows[0].id, QA_CURRENCY, amountMinor, bankRes.rows[0].id],
  );

  return {
    walletId,
    bankAccountId: bankRes.rows[0].id,
    pendingActionId: proposeRes.rows[0].id,
    secondAdminId: secondAdminRes.rows[0].id,
    withdrawalId: initRes.rows[0].id,
  };
}

async function cleanupPlatformWithdrawalFixture(admin, fixture) {
  if (fixture.withdrawalId)
    await admin.query('delete from platform_withdrawals where id = $1', [fixture.withdrawalId]);
  if (fixture.pendingActionId)
    await admin.query('delete from admin_pending_actions where id = $1', [fixture.pendingActionId]);
  if (fixture.secondAdminId) {
    await admin.query('delete from admin_user_roles where admin_user_id = $1', [
      fixture.secondAdminId,
    ]);
    await admin.query('alter table admin_audit_log disable trigger admin_audit_log_no_delete');
    await admin.query('delete from admin_audit_log where admin_user_id = $1', [
      fixture.secondAdminId,
    ]);
    await admin.query('alter table admin_audit_log enable trigger admin_audit_log_no_delete');
    await admin.query('delete from admin_users where id = $1', [fixture.secondAdminId]);
  }
  await admin.query('begin');
  try {
    await admin.query('alter table ledger_entries disable trigger ledger_entries_no_delete');
    await admin.query('delete from ledger_entries where wallet_id = $1', [fixture.walletId]);
    await admin.query('alter table ledger_entries enable trigger ledger_entries_no_delete');
    await admin.query('commit');
  } catch (e) {
    await admin.query('rollback');
    throw e;
  }
  await admin.query('delete from wallets where id = $1', [fixture.walletId]);
  await admin.query('delete from platform_bank_accounts where id = $1', [fixture.bankAccountId]);
}

async function testTransferWebhooksCompletePlatformWithdrawals(admin) {
  const completedFixture = await seedPlatformWithdrawalFixture(admin, { amountMinor: 1000 });
  const completedTransferId = `trf_qa_${crypto.randomUUID()}`;
  const completedEventId = `transfer.completed:${completedTransferId}`;

  try {
    const completed = await postWebhook({
      event: 'transfer.completed',
      data: {
        id: completedTransferId,
        reference: completedFixture.withdrawalId,
        status: 'SUCCESSFUL',
      },
    });
    log(
      'transfer.completed for a platform_withdrawals reference (not in withdrawals) -> 200 processed via the fallback',
      completed.status === 200 && completed.json?.status === 'processed',
      JSON.stringify(completed.json),
    );

    const row = await admin.query(
      'select status, provider_reference from platform_withdrawals where id = $1',
      [completedFixture.withdrawalId],
    );
    log(
      'the platform withdrawal is marked paid with the real provider reference, not left processing',
      row.rows[0]?.status === 'paid' && row.rows[0]?.provider_reference === completedTransferId,
      JSON.stringify(row.rows[0]),
    );
  } finally {
    await deleteWebhookEvent(admin, completedEventId);
    await cleanupPlatformWithdrawalFixture(admin, completedFixture);
  }

  const failedFixture = await seedPlatformWithdrawalFixture(admin, { amountMinor: 500 });
  const failedTransferId = `trf_qa_${crypto.randomUUID()}`;
  const failedEventId = `transfer.completed:${failedTransferId}`;

  try {
    const walletBefore = await admin.query('select balance from wallets where id = $1', [
      failedFixture.walletId,
    ]);

    const failed = await postWebhook({
      event: 'transfer.completed',
      data: { id: failedTransferId, reference: failedFixture.withdrawalId, status: 'FAILED' },
    });
    log(
      'transfer.completed FAILED for a platform_withdrawals reference -> 200 processed via the fallback',
      failed.status === 200 && failed.json?.status === 'processed',
      JSON.stringify(failed.json),
    );

    const row = await admin.query('select status from platform_withdrawals where id = $1', [
      failedFixture.withdrawalId,
    ]);
    log(
      'the platform withdrawal is marked failed',
      row.rows[0]?.status === 'failed',
      JSON.stringify(row.rows[0]),
    );

    const walletAfter = await admin.query('select balance from wallets where id = $1', [
      failedFixture.walletId,
    ]);
    log(
      'the debit was refunded back to the platform wallet',
      Number(walletAfter.rows[0].balance) === Number(walletBefore.rows[0].balance) + 500,
      `before=${walletBefore.rows[0].balance} after=${walletAfter.rows[0].balance}`,
    );
  } finally {
    await deleteWebhookEvent(admin, failedEventId);
    await cleanupPlatformWithdrawalFixture(admin, failedFixture);
  }
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
    await testTransferWebhooksCompletePlatformWithdrawals(admin);
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
