#!/usr/bin/env node
// Reserve buffer + clawback-as-debt (docs/06-SECURITY-FRAUD-LOOPHOLES.md §3;
// docs/00-SESSION-HANDOFF.md session 14) — direct DB-level tests against the
// real linked dev database, same pattern as wallet-functions.test.js and
// fraud-functions.test.js (plain pg.Client + fn_ calls, no HTTP/deno layer —
// fn_credit_platform_revenue and fn_process_chargeback are both pure SQL,
// there is no Edge Function wrapper for either). Run via `npm run
// test:chargeback`.
//
// Covers: fn_credit_platform_revenue's reserve split lands correctly (via
// real fn_confirm_topup and fn_release_escrow calls, not a direct unit
// test of the helper) with net+reserve always summing to the original
// amount; fn_process_chargeback debits the payer's topup_credit wallet
// into negative territory (the debt), reverses the platform's fee revenue,
// freezes the payer's wallet so every spend path that already checks
// is_frozen blocks further activity, logs a fraud_signals row, and leaves
// the payee's wallets completely untouched; idempotency on replay;
// concurrency (two simultaneous chargebacks on the same topup can't double
// debit); and the error paths (unknown topup, non-completed topup).

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:chargeback` from the repo root.',
  );
  process.exit(1);
}

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

function newClient() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  client.on('error', (e) => {
    process.stderr.write(`[connection error, non-fatal to the test run] ${e.message}\n`);
  });
  return client;
}

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

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function deleteTestUser(admin, id) {
  await admin.query('begin');
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('commit');
  await admin.query('delete from public.topups where user_id = $1', [id]);
  await admin.query(
    'delete from public.credit_transfers where sender_id = $1 or recipient_id = $1',
    [id],
  );
  await admin.query('delete from public.fraud_signals where user_id = $1 or related_user_id = $1', [
    id,
  ]);
  await admin.query('delete from auth.users where id = $1', [id]); // cascades to public.users
}

async function walletRow(admin, userId, kind) {
  const r = await admin.query(
    'select id, balance, is_frozen from public.wallets where user_id=$1 and kind=$2',
    [userId, kind],
  );
  return r.rows[0];
}

async function platformWalletRow(admin, kind) {
  const r = await admin.query(
    'select id, balance from public.wallets where user_id is null and kind=$1',
    [kind],
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

async function confirmedTopup(admin, userId, amountKobo) {
  const topupRes = await admin.query('select public.fn_buy_credit($1, $2, $3) as id', [
    userId,
    amountKobo,
    'flutterwave',
  ]);
  const topupId = topupRes.rows[0].id;
  await admin.query('select public.fn_confirm_topup($1, $2)', [topupId, `test-ref-${topupId}`]);
  const row = await admin.query('select * from public.topups where id = $1', [topupId]);
  return row.rows[0];
}

// =============================================================================
// Test 1: the reserve skim on a real fn_confirm_topup call — net (revenue)
// + reserve always sum to the topup's own platform_fee_kobo, and the
// reserve wallet gets exactly platform_reserve_bps of it.
// =============================================================================

async function testReserveSkimOnTopupConfirm(admin) {
  const reserveBps = await pricingValue(admin, 'platform_reserve_bps');
  const A = await createTestUser(admin);

  const revenueBefore = await platformWalletRow(admin, 'platform_revenue_topup_fees');
  const reserveBefore = await platformWalletRow(admin, 'platform_reserve_topup_fees');

  const topup = await confirmedTopup(admin, A, 500000);

  const revenueAfter = await platformWalletRow(admin, 'platform_revenue_topup_fees');
  const reserveAfter = await platformWalletRow(admin, 'platform_reserve_topup_fees');

  const netDelta = Number(revenueAfter.balance) - Number(revenueBefore.balance);
  const reserveDelta = Number(reserveAfter.balance) - Number(reserveBefore.balance);
  const expectedReserve = Math.round((Number(topup.platform_fee_kobo) * reserveBps) / 10000);
  const expectedNet = Number(topup.platform_fee_kobo) - expectedReserve;

  log(
    'the reserve wallet gets exactly platform_reserve_bps of the topup fee',
    reserveDelta === expectedReserve,
    `expected=${expectedReserve} actual=${reserveDelta}`,
  );
  log(
    'the revenue wallet gets the remainder, not independently rounded',
    netDelta === expectedNet,
    `expected=${expectedNet} actual=${netDelta}`,
  );
  log(
    'net + reserve sum to exactly the original platform_fee_kobo (no leakage)',
    netDelta + reserveDelta === Number(topup.platform_fee_kobo),
    `net=${netDelta} reserve=${reserveDelta} fee=${topup.platform_fee_kobo}`,
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 2: the reserve skim on a real fn_release_escrow call — same
// conservation property, this time in credits on the earnings-cut side.
// A single message's platform cut is small enough (message credits are
// capped, docs/06 §1) that platform_reserve_bps of it can legitimately
// round to 0 — that's correct behavior, not a bug, so this asserts the
// conservation identity (net + reserve == the actual platform cut) rather
// than a specific nonzero expected reserve value. Test 3 (credit transfer)
// covers a scenario large enough to demonstrate a genuinely nonzero skim.
// =============================================================================

async function testReserveSkimOnEscrowRelease(admin) {
  const takeBps = await pricingValue(admin, 'platform_earning_take_bps');
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await confirmedTopup(admin, A, 500000);

  const revenueBefore = await platformWalletRow(admin, 'platform_revenue_earnings_cut');
  const reserveBefore = await platformWalletRow(admin, 'platform_reserve_earnings_cut');

  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;

  await admin.query('select public.fn_send_message($1, $2, $3)', [
    threadId,
    A,
    'hello there, how are you',
  ]);
  await admin.query('select public.fn_send_message($1, $2, $3)', [
    threadId,
    B,
    'I am doing well thanks',
  ]);
  // fn_release_escrow now takes the sender explicitly (docs/18 §C1's
  // fn_release_escrow correction — it's payee-agnostic since threads can
  // have a mutable payer role) — B is the payee here, and B's own send
  // above already triggered this release; this call is now a deliberate,
  // harmless no-op that exercises the direct-call path this suite has
  // always used, not a second real release.
  await admin.query('select public.fn_release_escrow($1, $2)', [threadId, B]);

  const revenueAfter = await platformWalletRow(admin, 'platform_revenue_earnings_cut');
  const reserveAfter = await platformWalletRow(admin, 'platform_reserve_earnings_cut');

  const netDelta = Number(revenueAfter.balance) - Number(revenueBefore.balance);
  const reserveDelta = Number(reserveAfter.balance) - Number(reserveBefore.balance);
  const platformCut = Math.round((2 * takeBps) / 10000);

  log(
    'escrow release: net + reserve sum to exactly the platform cut (no leakage)',
    netDelta + reserveDelta === platformCut,
    `net=${netDelta} reserve=${reserveDelta} platform_cut=${platformCut}`,
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 3: the reserve skim on a real fn_transfer_credit call, sized large
// enough (unlike a single message's platform cut) to demonstrate a
// genuinely nonzero reserve skim, not just the conservation identity.
// =============================================================================

async function testReserveSkimOnCreditTransfer(admin) {
  const reserveBps = await pricingValue(admin, 'platform_reserve_bps');
  const transferTakeBps = await pricingValue(admin, 'platform_transfer_take_bps');
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await admin.query('update public.users set kyc_tier = 1 where id = $1', [B]);
  // Stays comfortably under new_account_daily_topup_cap_kobo (₦20,000) so
  // this doesn't trip docs/06 §4's new-account velocity limit — 600,000
  // kobo nets ~588 credits after the 2% fee, enough to cover a 500-credit
  // transfer below.
  await confirmedTopup(admin, A, 600000);

  const revenueBefore = await platformWalletRow(admin, 'platform_revenue_earnings_cut');
  const reserveBefore = await platformWalletRow(admin, 'platform_reserve_earnings_cut');

  const transferCredits = 500;
  await admin.query('select public.fn_transfer_credit($1, $2, $3, $4)', [
    A,
    B,
    transferCredits,
    'reserve skim test',
  ]);

  const revenueAfter = await platformWalletRow(admin, 'platform_revenue_earnings_cut');
  const reserveAfter = await platformWalletRow(admin, 'platform_reserve_earnings_cut');

  const netDelta = Number(revenueAfter.balance) - Number(revenueBefore.balance);
  const reserveDelta = Number(reserveAfter.balance) - Number(reserveBefore.balance);
  const platformCut = Math.round((transferCredits * transferTakeBps) / 10000);
  const expectedReserve = Math.round((platformCut * reserveBps) / 10000);

  log(
    'credit transfer: the reserve skim is genuinely nonzero at this size',
    reserveDelta > 0,
    `reserve_delta=${reserveDelta}`,
  );
  log(
    'credit transfer: the reserve wallet gets exactly platform_reserve_bps of the platform cut',
    reserveDelta === expectedReserve,
    `expected=${expectedReserve} actual=${reserveDelta}`,
  );
  log(
    'credit transfer: net + reserve sum to exactly the platform cut',
    netDelta + reserveDelta === platformCut,
    `net=${netDelta} reserve=${reserveDelta} platform_cut=${platformCut}`,
  );

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 3: the core clawback scenario — a completed topup whose credits
// were already spent gets charged back: the payer's wallet goes negative
// by the full amount, the platform's fee revenue is reversed, the payer's
// wallet is frozen (blocking further sends), a fraud_signals row is
// logged, and the payee — who earned in good faith — is completely
// untouched.
// =============================================================================

async function testChargebackCreatesDebtAndFreezes(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const topup = await confirmedTopup(admin, A, 500000);

  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;
  await admin.query('select public.fn_send_message($1, $2, $3)', [
    threadId,
    A,
    'hello there, how are you',
  ]);
  await admin.query('select public.fn_send_message($1, $2, $3)', [
    threadId,
    B,
    'I am doing well thanks',
  ]);
  // fn_release_escrow now takes the sender explicitly (docs/18 §C1's
  // fn_release_escrow correction — it's payee-agnostic since threads can
  // have a mutable payer role) — B is the payee here, and B's own send
  // above already triggered this release; this call is now a deliberate,
  // harmless no-op that exercises the direct-call path this suite has
  // always used, not a second real release.
  await admin.query('select public.fn_release_escrow($1, $2)', [threadId, B]);

  const bCashBefore = await walletRow(admin, B, 'withdrawable_cash');
  const bEarningsBefore = await walletRow(admin, B, 'earnings_pending');

  const aWalletBeforeCB = await walletRow(admin, A, 'topup_credit');

  const revenueBeforeCB = await platformWalletRow(admin, 'platform_revenue_topup_fees');

  const cbRes = await admin.query('select * from public.fn_process_chargeback($1, $2)', [
    topup.id,
    'test dispute',
  ]);

  const aWalletAfterCB = await walletRow(admin, A, 'topup_credit');
  log(
    "the payer's wallet goes negative by exactly the credits issued on that topup",
    Number(aWalletAfterCB.balance) ===
      Number(aWalletBeforeCB.balance) - Number(topup.credits_issued),
    `before=${aWalletBeforeCB.balance} after=${aWalletAfterCB.balance} credits_issued=${topup.credits_issued}`,
  );
  log(
    'the returned credits_debited matches the topup credits_issued',
    Number(cbRes.rows[0].credits_debited) === Number(topup.credits_issued),
    `expected=${topup.credits_issued} actual=${cbRes.rows[0].credits_debited}`,
  );
  log(
    "the payer's topup_credit wallet is now frozen",
    aWalletAfterCB.is_frozen === true,
    `is_frozen=${aWalletAfterCB.is_frozen}`,
  );

  const revenueAfterCB = await platformWalletRow(admin, 'platform_revenue_topup_fees');
  log(
    "the platform's fee revenue for that topup is fully reversed",
    Number(revenueAfterCB.balance) ===
      Number(revenueBeforeCB.balance) - Number(topup.platform_fee_kobo),
    `before=${revenueBeforeCB.balance} after=${revenueAfterCB.balance} fee=${topup.platform_fee_kobo}`,
  );

  const topupAfterCB = await admin.query('select status from public.topups where id = $1', [
    topup.id,
  ]);
  log(
    "the topup's status is 'reversed'",
    topupAfterCB.rows[0].status === 'reversed',
    `status=${topupAfterCB.rows[0].status}`,
  );

  const signal = await admin.query(
    `select severity, metadata from public.fraud_signals where user_id = $1 and signal_type = 'chargeback'`,
    [A],
  );
  log(
    'a high-severity chargeback fraud_signals row is logged, referencing the topup',
    signal.rows.length === 1 &&
      signal.rows[0].severity === 'high' &&
      signal.rows[0].metadata.topup_id === topup.id,
    JSON.stringify(signal.rows[0]),
  );

  // Blocked further activity — the frozen wallet must reject a new send.
  let blocked = false;
  try {
    await admin.query('select public.fn_send_message($1, $2, $3)', [threadId, A, 'trying again']);
  } catch (e) {
    blocked = /wallet_frozen/.test(e.message);
  }
  log('the payer is blocked from sending further messages while frozen', blocked);

  // The payee kept what they earned in good faith — completely untouched.
  const bCashAfter = await walletRow(admin, B, 'withdrawable_cash');
  const bEarningsAfter = await walletRow(admin, B, 'earnings_pending');
  log(
    "the payee's withdrawable_cash is untouched by the payer's chargeback",
    Number(bCashAfter.balance) === Number(bCashBefore.balance),
    `before=${bCashBefore.balance} after=${bCashAfter.balance}`,
  );
  log(
    "the payee's earnings_pending is untouched by the payer's chargeback",
    Number(bEarningsAfter.balance) === Number(bEarningsBefore.balance),
    `before=${bEarningsBefore.balance} after=${bEarningsAfter.balance}`,
  );

  // Ledger conservation across every wallet this scenario touched.
  const wallets = [
    ['A topup_credit', (await walletRow(admin, A, 'topup_credit')).id],
    ['B earnings_pending', (await walletRow(admin, B, 'earnings_pending')).id],
    ['B withdrawable_cash', (await walletRow(admin, B, 'withdrawable_cash')).id],
    [
      'platform_revenue_topup_fees',
      (await platformWalletRow(admin, 'platform_revenue_topup_fees')).id,
    ],
    [
      'platform_reserve_topup_fees',
      (await platformWalletRow(admin, 'platform_reserve_topup_fees')).id,
    ],
    [
      'platform_revenue_earnings_cut',
      (await platformWalletRow(admin, 'platform_revenue_earnings_cut')).id,
    ],
    [
      'platform_reserve_earnings_cut',
      (await platformWalletRow(admin, 'platform_reserve_earnings_cut')).id,
    ],
  ];
  let allOk = true;
  const details = [];
  for (const [label, walletId] of wallets) {
    const w = await admin.query('select balance from public.wallets where id = $1', [walletId]);
    const sum = await ledgerSum(admin, walletId);
    const ok = sum === Number(w.rows[0].balance);
    if (!ok) allOk = false;
    details.push({ label, balance: w.rows[0].balance, sum, ok });
  }
  log(
    'ledger conservation holds on every wallet touched by the chargeback',
    allOk,
    JSON.stringify(details.filter((d) => !d.ok)),
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 4: idempotency — calling fn_process_chargeback again on an
// already-reversed topup is a no-op (0 debited), not a double debit.
// =============================================================================

async function testChargebackIsIdempotent(admin) {
  const A = await createTestUser(admin);
  const topup = await confirmedTopup(admin, A, 200000);

  await admin.query('select * from public.fn_process_chargeback($1)', [topup.id]);
  const walletAfterFirst = await walletRow(admin, A, 'topup_credit');

  const second = await admin.query('select * from public.fn_process_chargeback($1)', [topup.id]);
  const walletAfterSecond = await walletRow(admin, A, 'topup_credit');

  log(
    'a second chargeback call on the same topup debits 0 credits',
    Number(second.rows[0].credits_debited) === 0,
    `credits_debited=${second.rows[0].credits_debited}`,
  );
  log(
    "the payer's balance is unchanged by the second call",
    Number(walletAfterSecond.balance) === Number(walletAfterFirst.balance),
    `after_first=${walletAfterFirst.balance} after_second=${walletAfterSecond.balance}`,
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 5: error paths — an unknown topup id raises topup_not_found; a
// topup that was never confirmed (still pending) raises
// topup_not_completed rather than silently doing nothing.
// =============================================================================

async function testChargebackErrorPaths(admin) {
  const A = await createTestUser(admin);

  let unknownError = null;
  try {
    await admin.query('select * from public.fn_process_chargeback($1)', [crypto.randomUUID()]);
  } catch (e) {
    unknownError = e.message;
  }
  log(
    'an unknown topup id raises topup_not_found',
    /topup_not_found/.test(unknownError ?? ''),
    unknownError,
  );

  const pendingTopupRes = await admin.query('select public.fn_buy_credit($1, $2, $3) as id', [
    A,
    50000,
    'flutterwave',
  ]);
  let pendingError = null;
  try {
    await admin.query('select * from public.fn_process_chargeback($1)', [
      pendingTopupRes.rows[0].id,
    ]);
  } catch (e) {
    pendingError = e.message;
  }
  log(
    'a never-confirmed (pending) topup raises topup_not_completed, not a silent no-op',
    /topup_not_completed/.test(pendingError ?? ''),
    pendingError,
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 6: concurrency — two simultaneous fn_process_chargeback calls on the
// same topup can't double-debit (row lock + status check serializes it,
// same shape as fn_confirm_topup's own idempotent-race test).
// =============================================================================

async function testConcurrentChargebackCannotDoubleDebit(admin) {
  const A = await createTestUser(admin);
  const topup = await confirmedTopup(admin, A, 300000);
  const walletBefore = await walletRow(admin, A, 'topup_credit');

  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();

  const results = await Promise.allSettled([
    c1.query('select * from public.fn_process_chargeback($1)', [topup.id]),
    c2.query('select * from public.fn_process_chargeback($1)', [topup.id]),
  ]);

  await c1.end();
  await c2.end();

  const bothSettled = results.every((r) => r.status === 'fulfilled');
  log(
    'both racing chargeback calls complete without error (idempotent, not rejected)',
    bothSettled,
    JSON.stringify(results.map((r) => r.status)),
  );

  const wallet = await walletRow(admin, A, 'topup_credit');
  const expectedBalance = Number(walletBefore.balance) - Number(topup.credits_issued);
  log(
    'credits are clawed back exactly once despite the race, not double-debited',
    Number(wallet.balance) === expectedBalance,
    `expected=${expectedBalance} actual=${wallet.balance}`,
  );

  const sum = await ledgerSum(admin, wallet.id);
  log(
    'ledger conservation holds on the payer wallet after the race',
    sum === Number(wallet.balance),
    `ledger_sum=${sum} balance=${wallet.balance}`,
  );

  await deleteTestUser(admin, A);
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testReserveSkimOnTopupConfirm(admin);
    await testReserveSkimOnEscrowRelease(admin);
    await testReserveSkimOnCreditTransfer(admin);
    await testChargebackCreatesDebtAndFreezes(admin);
    await testChargebackIsIdempotent(admin);
    await testChargebackErrorPaths(admin);
    await testConcurrentChargebackCannotDoubleDebit(admin);
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
