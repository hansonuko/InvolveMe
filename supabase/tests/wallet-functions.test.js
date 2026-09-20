#!/usr/bin/env node
// Phase 1 item 6 — concurrency & ledger-conservation tests. See README.md.
//
// Every test user/wallet touched here uses a fresh random UUID per run, so
// this is safe to re-run without manual cleanup even if a previous run
// crashed mid-test — nothing is hardcoded and reused across runs.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is not set. Run via `npm run test:db` from the repo root.');
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
  // The dev pooler drops connections mid-session occasionally (observed
  // repeatedly during development, unrelated to anything under test). A
  // `pg.Client` emits 'error' on that, and Node treats an unhandled
  // 'error' event as fatal — this listener converts a random infra blip
  // into a normal (still-failing, still-reported) test result instead of
  // crashing the whole process with a stack trace.
  client.on('error', (e) => {
    process.stderr.write(`[connection error, non-fatal to the test run] ${e.message}\n`);
  });
  return client;
}

async function createTestUser(admin) {
  const id = crypto.randomUUID();
  // Fully random phone, not a deterministic counter — a run that crashes
  // before cleanup must not collide with the next run's fixed numbers
  // (this bit a rerun during development: see docs/00-SESSION-HANDOFF.md).
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  await admin.query(
    `insert into auth.users (id, phone, created_at, aud, role, instance_id)
     values ($1, $2, now(), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`,
    [id, phone],
  );
  return id;
}

// A thread's messages can have sender_id pointing at *either* participant —
// so cleaning up "everything belonging to user X" one user at a time (as
// deleteTestUser below does) leaves the other participant's messages
// dangling and blocks the thread delete with an FK violation. Threads must
// be torn down as a unit, by thread id, before either participant is
// deleted — not folded into per-user cleanup.
async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function deleteTestUser(admin, id) {
  // Dependency order matters — see docs/00-SESSION-HANDOFF.md "A schema
  // behavior worth knowing": no ON DELETE CASCADE from users to
  // threads/messages/escrows/withdrawals, by design. Any thread this user
  // was part of must already be gone via deleteTestThread by this point.
  admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id = $1
     )`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from public.withdrawals where user_id = $1', [id]);
  await admin.query('delete from public.bank_accounts where user_id = $1', [id]);
  await admin.query('delete from public.topups where user_id = $1', [id]);
  await admin.query(
    'delete from public.credit_transfers where sender_id = $1 or recipient_id = $1',
    [id],
  );
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

// =============================================================================
// Test 1: two simultaneous fn_send_message calls against a wallet funded for
// exactly one 2-credit message must not both succeed.
// =============================================================================

async function testConcurrentSendMessagePreventsDoubleSpend(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);

  const aWallet = await walletRow(admin, A, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 2, 'manual_adjustment')`,
    [aWallet.id],
  );

  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;

  // Two separate physical connections firing at the same time — a single
  // Client processes queries serially even without awaiting, so genuine
  // concurrency needs genuinely separate connections.
  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();

  const results = await Promise.allSettled([
    c1.query('select * from public.fn_send_message($1, $2, $3)', [threadId, A, 'hello there']),
    c2.query('select * from public.fn_send_message($1, $2, $3)', [threadId, A, 'hello again']),
  ]);

  await c1.end();
  await c2.end();

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  log(
    'exactly one of two concurrent sends succeeds when balance covers only one',
    succeeded.length === 1 && failed.length === 1,
    `succeeded=${succeeded.length} failed=${failed.length}`,
  );

  log(
    'the loser fails with insufficient_credit, not some other error',
    failed.length === 1 && /insufficient_credit/.test(failed[0].reason.message),
    failed[0] ? failed[0].reason.message : 'n/a',
  );

  const aWalletAfter = await walletRow(admin, A, 'topup_credit');
  log(
    'balance never goes negative and matches exactly one debit',
    Number(aWalletAfter.balance) === 0,
    `balance=${aWalletAfter.balance}`,
  );

  const sum = await ledgerSum(admin, aWallet.id);
  log(
    'ledger conservation holds on the payer wallet after the race',
    sum === Number(aWalletAfter.balance),
    `ledger_sum=${sum} balance=${aWalletAfter.balance}`,
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 2: two simultaneous fn_confirm_topup calls for the same topup
// (simulating a duplicate/racing webhook delivery, not a sequential retry)
// must issue credits exactly once.
// =============================================================================

async function testConcurrentTopupConfirmationIsIdempotent(admin) {
  const A = await createTestUser(admin);

  const topupRes = await admin.query('select public.fn_buy_credit($1, 100000, $2) as id', [
    A,
    'flutterwave',
  ]);
  const topupId = topupRes.rows[0].id;

  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();

  const results = await Promise.allSettled([
    c1.query('select public.fn_confirm_topup($1, $2)', [topupId, 'race-ref-1']),
    c2.query('select public.fn_confirm_topup($1, $2)', [topupId, 'race-ref-2']),
  ]);

  await c1.end();
  await c2.end();

  const bothSettled = results.every((r) => r.status === 'fulfilled');
  // fn_confirm_topup is designed to be idempotent (no-op on already-completed),
  // not to reject the loser — so both calls are expected to succeed, but
  // credits must only land once. That's the actual property under test.

  const aWallet = await walletRow(admin, A, 'topup_credit');

  log(
    'both racing confirm calls complete without error (idempotent, not rejected)',
    bothSettled,
    JSON.stringify(results.map((r) => r.status)),
  );

  log(
    'credits are issued exactly once despite the race (98 credits, not 196)',
    Number(aWallet.balance) === 98,
    `balance=${aWallet.balance}`,
  );

  const sum = await ledgerSum(admin, aWallet.id);
  log(
    'ledger conservation holds on the topup_credit wallet after the race',
    sum === Number(aWallet.balance),
    `ledger_sum=${sum} balance=${aWallet.balance}`,
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 3: two simultaneous fn_initiate_withdrawal calls against a wallet
// funded for exactly one withdrawal must not both succeed.
// =============================================================================

async function testConcurrentWithdrawalPreventsDoubleSpend(admin) {
  const A = await createTestUser(admin);

  await admin.query('update public.users set kyc_tier = 1 where id = $1', [A]);
  const bankRes = await admin.query(
    `insert into public.bank_accounts (user_id, bank_name, account_name, name_match_verified)
     values ($1, 'Test Bank', 'Concurrency Test', true) returning id`,
    [A],
  );
  const bankAccountId = bankRes.rows[0].id;

  const wallet = await walletRow(admin, A, 'withdrawable_cash');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 100000, 'earnings_conversion')`,
    [wallet.id],
  );

  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();

  const results = await Promise.allSettled([
    c1.query('select * from public.fn_initiate_withdrawal($1, $2, $3, $4)', [
      A,
      bankAccountId,
      100000,
      false,
    ]),
    c2.query('select * from public.fn_initiate_withdrawal($1, $2, $3, $4)', [
      A,
      bankAccountId,
      100000,
      false,
    ]),
  ]);

  await c1.end();
  await c2.end();

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  log(
    'exactly one of two concurrent withdrawal requests succeeds',
    succeeded.length === 1 && failed.length === 1,
    `succeeded=${succeeded.length} failed=${failed.length}`,
  );

  const walletAfter = await walletRow(admin, A, 'withdrawable_cash');
  log(
    'withdrawable_cash never goes negative',
    Number(walletAfter.balance) === 0,
    `balance=${walletAfter.balance}`,
  );

  const sum = await ledgerSum(admin, wallet.id);
  log(
    'ledger conservation holds on withdrawable_cash after the race',
    sum === Number(walletAfter.balance),
    `ledger_sum=${sum} balance=${walletAfter.balance}`,
  );

  await deleteTestUser(admin, A);
}

// =============================================================================
// Test 4: ledger conservation across a batch of concurrent, unrelated
// operations touching several different wallets at once.
// =============================================================================

async function testLedgerConservationUnderConcurrentLoad(admin) {
  const users = [];
  for (let i = 0; i < 4; i++) {
    users.push(await createTestUser(admin));
  }
  const [A, B, C, D] = users;

  // Fund A and C as payers.
  for (const payer of [A, C]) {
    const w = await walletRow(admin, payer, 'topup_credit');
    await admin.query(
      `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 40, 'manual_adjustment')`,
      [w.id],
    );
  }

  const threadAB = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]))
    .rows[0].id;
  const threadCD = (await admin.query('select public.fn_start_thread($1, $2) as id', [C, D]))
    .rows[0].id;

  const clients = [newClient(), newClient(), newClient(), newClient()];
  await Promise.all(clients.map((cl) => cl.connect()));

  // Two independent conversations proceeding concurrently: each pair does an
  // initial message + a reply, all four queries fired at once.
  await Promise.allSettled([
    clients[0].query('select * from public.fn_send_message($1, $2, $3)', [
      threadAB,
      A,
      'hi there b',
    ]),
    clients[1].query('select * from public.fn_send_message($1, $2, $3)', [
      threadCD,
      C,
      'hi there d',
    ]),
  ]);

  await Promise.allSettled([
    clients[2].query('select * from public.fn_send_message($1, $2, $3)', [
      threadAB,
      B,
      'hello a, how are you',
    ]),
    clients[3].query('select * from public.fn_send_message($1, $2, $3)', [
      threadCD,
      D,
      'hello c, how are you',
    ]),
  ]);

  await Promise.all(clients.map((cl) => cl.end()));

  // Check every wallet touched by any of the four users, plus the two
  // platform wallets, for ledger conservation — not just the happy-path
  // numbers, the actual invariant CLAUDE.md cares about.
  let allReconciled = true;
  const details = [];
  for (const userId of users) {
    for (const kind of ['topup_credit', 'earnings_pending', 'withdrawable_cash']) {
      const w = await walletRow(admin, userId, kind);
      const sum = await ledgerSum(admin, w.id);
      const ok = sum === Number(w.balance);
      if (!ok) allReconciled = false;
      details.push({ userId, kind, balance: w.balance, sum, ok });
    }
  }
  for (const kind of ['platform_revenue_topup_fees', 'platform_revenue_earnings_cut']) {
    const r = await admin.query(
      'select id, balance from public.wallets where user_id is null and kind=$1',
      [kind],
    );
    const sum = await ledgerSum(admin, r.rows[0].id);
    const ok = sum === Number(r.rows[0].balance);
    if (!ok) allReconciled = false;
    details.push({ kind, balance: r.rows[0].balance, sum, ok });
  }

  log(
    'every wallet touched by concurrent operations reconciles against its ledger',
    allReconciled,
    allReconciled ? undefined : JSON.stringify(details.filter((d) => !d.ok)),
  );

  await deleteTestThread(admin, threadAB);
  await deleteTestThread(admin, threadCD);
  for (const userId of users) {
    await deleteTestUser(admin, userId);
  }
}

// =============================================================================
// Test 5: fn_transfer_credit splits correctly (platform_transfer_take_bps)
// and every wallet it touches — sender's topup_credit, recipient's
// earnings_pending pass-through, recipient's withdrawable_cash, and the
// platform's earnings-cut wallet — reconciles against its ledger.
// =============================================================================

async function testTransferSplitAndLedgerConservation(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  // fn_transfer_credit now requires a Tier-1 recipient (session 13,
  // docs/06-SECURITY-FRAUD-LOOPHOLES.md §2) — this test is about the
  // split/ledger math, not the KYC gate itself (covered in
  // fraud-functions.test.js), so satisfy the gate rather than route
  // around what it's actually testing.
  await admin.query('update public.users set kyc_tier = 1 where id = $1', [B]);

  const aWallet = await walletRow(admin, A, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 100, 'manual_adjustment')`,
    [aWallet.id],
  );

  const transferRes = await admin.query('select public.fn_transfer_credit($1, $2, $3, $4) as id', [
    A,
    B,
    100,
    'test transfer',
  ]);
  const transferId = transferRes.rows[0].id;

  const transferRow = (
    await admin.query('select * from public.credit_transfers where id = $1', [transferId])
  ).rows[0];

  // Default platform_transfer_take_bps seed is 2000 (20%): 100 credits in ->
  // 20 platform cut, 80 to the recipient. Asserted against the config value
  // actually in the DB, not the seed default, so this doesn't silently
  // start lying if ops retunes the rate later.
  const takeBps = Number(
    (
      await admin.query(
        "select value from public.pricing_config where key = 'platform_transfer_take_bps'",
      )
    ).rows[0].value,
  );
  const expectedCut = Math.round((100 * takeBps) / 10000);
  const expectedPayee = 100 - expectedCut;

  log(
    'credit_transfers row records the correct split',
    Number(transferRow.credits_sent) === 100 &&
      Number(transferRow.platform_cut_credits) === expectedCut &&
      Number(transferRow.credits_received) === expectedPayee,
    JSON.stringify(transferRow),
  );

  const aWalletAfter = await walletRow(admin, A, 'topup_credit');
  log(
    "sender's topup_credit is debited by the full amount sent, not the post-cut amount",
    Number(aWalletAfter.balance) === 0,
    `balance=${aWalletAfter.balance}`,
  );

  const bEarnings = await walletRow(admin, B, 'earnings_pending');
  log(
    "recipient's earnings_pending nets to zero (credit then immediate conversion, same shape as an escrow release)",
    Number(bEarnings.balance) === 0,
    `balance=${bEarnings.balance}`,
  );

  const bCash = await walletRow(admin, B, 'withdrawable_cash');
  const unitKobo = Number(
    (await admin.query("select value from public.pricing_config where key = 'credit_unit_kobo'"))
      .rows[0].value,
  );
  log(
    'the post-cut amount lands in withdrawable_cash at the fixed credit_unit_kobo rate',
    Number(bCash.balance) === expectedPayee * unitKobo,
    `balance=${bCash.balance} expected=${expectedPayee * unitKobo}`,
  );

  for (const [label, wallet] of [
    ['sender topup_credit', aWalletAfter],
    ['recipient earnings_pending', bEarnings],
    ['recipient withdrawable_cash', bCash],
  ]) {
    const sum = await ledgerSum(admin, wallet.id);
    log(
      `ledger conservation holds on ${label}`,
      sum === Number(wallet.balance),
      `ledger_sum=${sum} balance=${wallet.balance}`,
    );
  }

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 6: two simultaneous fn_transfer_credit calls against a sender wallet
// funded for exactly one transfer must not both succeed.
// =============================================================================

async function testConcurrentTransferPreventsDoubleSpend(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await admin.query('update public.users set kyc_tier = 1 where id = $1', [B]); // see testTransferSplitAndLedgerConservation's comment

  const aWallet = await walletRow(admin, A, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 50, 'manual_adjustment')`,
    [aWallet.id],
  );

  const c1 = newClient();
  const c2 = newClient();
  await c1.connect();
  await c2.connect();

  const results = await Promise.allSettled([
    c1.query('select public.fn_transfer_credit($1, $2, $3, $4)', [A, B, 50, null]),
    c2.query('select public.fn_transfer_credit($1, $2, $3, $4)', [A, B, 50, null]),
  ]);

  await c1.end();
  await c2.end();

  const succeeded = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  log(
    'exactly one of two concurrent transfers succeeds when balance covers only one',
    succeeded.length === 1 && failed.length === 1,
    `succeeded=${succeeded.length} failed=${failed.length}`,
  );

  log(
    'the loser fails with insufficient_credit, not some other error',
    failed.length === 1 && /insufficient_credit/.test(failed[0].reason.message),
    failed[0] ? failed[0].reason.message : 'n/a',
  );

  const aWalletAfter = await walletRow(admin, A, 'topup_credit');
  log(
    "sender's balance never goes negative and matches exactly one debit",
    Number(aWalletAfter.balance) === 0,
    `balance=${aWalletAfter.balance}`,
  );

  const sum = await ledgerSum(admin, aWallet.id);
  log(
    'ledger conservation holds on the sender wallet after the race',
    sum === Number(aWalletAfter.balance),
    `ledger_sum=${sum} balance=${aWalletAfter.balance}`,
  );

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testConcurrentSendMessagePreventsDoubleSpend(admin);
    await testConcurrentTopupConfirmationIsIdempotent(admin);
    await testConcurrentWithdrawalPreventsDoubleSpend(admin);
    await testLedgerConservationUnderConcurrentLoad(admin);
    await testTransferSplitAndLedgerConservation(admin);
    await testConcurrentTransferPreventsDoubleSpend(admin);
  } finally {
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;

  // Force-exit rather than rely on natural event-loop drain: observed this
  // suite hang indefinitely after every assertion had already logged and
  // passed (11/11), with no summary line printed — same root cause as
  // send-message-function.test.js hit and fixed in Phase 2 batch 1 (a
  // stray open handle outlives the last `await`, not anything the test
  // logic is actually still waiting on). Once every test's own cleanup
  // has run, as it has by this point, there's nothing left worth waiting
  // on.
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e.message);
  process.exit(1);
});
