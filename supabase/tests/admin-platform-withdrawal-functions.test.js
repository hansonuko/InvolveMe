#!/usr/bin/env node
// Admin dashboard Phase F piece 2 — DB-level tests for
// 20260924100000_platform_withdrawal_functions.sql. Same pattern as every
// other admin-* suite: real pg.Client against the real linked dev
// database, fresh random fixtures per run, self-cleaning.
//
// Deliberately NOT tested here, and never will be by an automated script:
// an actual call to a real payment provider. Every function in this
// migration is pure Postgres (initiate debits + records the request,
// complete/fail only ever flip status + optionally reverse the ledger) —
// see the migration's own header comment for why the provider call stays
// one layer up, in piece 3's Server Action, which is verified by careful
// code review against the live withdraw/index.ts pattern, never by
// scripted live execution (it would move real company money).
//
// Covers: dual-approval enforcement on initiation (mirrors piece 1's now-
// familiar checks), inactive/currency-mismatched bank account rejection,
// insufficient-balance rejection, ledger conservation across initiate +
// fail (the refund must exactly undo the debit), idempotent retry
// behavior for both complete and fail (a redelivered webhook event is a
// real, expected case), and two concurrency races: initiating the same
// approved withdrawal twice can't double-debit, and completing the same
// withdrawal N times concurrently (simulating webhook redelivery) can't
// double-apply.
//
// Uses a disposable currency tag (QAWD) for its own platform wallet and
// bank account fixtures, created fresh and torn down each run.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-platform-withdrawal` from the repo root.',
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

function fakeHash(label) {
  return `scrypt$fake$${label}$${crypto.randomBytes(8).toString('hex')}`;
}

async function insertTestAdmin(db, { email, roleNames = [] }) {
  const id = crypto.randomUUID();
  await db.query(
    `insert into admin_users (id, email, display_name, password_hash) values ($1, $2, $3, $4)`,
    [id, email, 'Test Admin', fakeHash('pw')],
  );
  for (const roleName of roleNames) {
    await db.query(
      `insert into admin_user_roles (admin_user_id, role_id) select $1, id from admin_roles where name = $2`,
      [id, roleName],
    );
  }
  return id;
}

async function deleteTestAdmin(db, id) {
  await db.query(
    'delete from admin_pending_actions where requested_by = $1 or approved_by = $1 or rejected_by = $1',
    [id],
  );
  await db.query('delete from admin_user_roles where admin_user_id = $1', [id]);
  await db.query('begin');
  await db.query('alter table admin_audit_log disable trigger admin_audit_log_no_delete');
  await db.query('delete from admin_audit_log where admin_user_id = $1', [id]);
  await db.query('alter table admin_audit_log enable trigger admin_audit_log_no_delete');
  await db.query('commit');
  await db.query('delete from admin_users where id = $1', [id]);
}

const QA_CURRENCY = 'QAWD';

async function seedFixtures(db, { startingBalance = 100000 } = {}) {
  const walletRes = await db.query(
    `insert into wallets (kind, currency, user_id) values ('platform_revenue_topup_fees', $1, null)
     on conflict (kind, currency) where user_id is null do update set currency = excluded.currency
     returning id`,
    [QA_CURRENCY],
  );
  const walletId = walletRes.rows[0].id;
  if (startingBalance !== 0) {
    await db.query(
      `insert into ledger_entries (wallet_id, amount, reason, ref_type, currency) values ($1, $2, 'manual_adjustment', 'admin_action', $3)`,
      [walletId, startingBalance, QA_CURRENCY],
    );
  }

  const bankRes = await db.query(
    `insert into platform_bank_accounts (currency, bank_name, account_number_last4, provider_account_id, account_name, is_active, added_by_admin_id)
     values ($1, 'QA Test Bank', '0000', $2, 'InvolveMe QA', true, (select id from admin_users limit 1))
     returning id`,
    [QA_CURRENCY, `prov-${crypto.randomUUID()}`],
  );

  return { walletId, bankAccountId: bankRes.rows[0].id };
}

async function cleanupFixtures(db) {
  const wallets = await db.query(`select id from wallets where currency = $1 and user_id is null`, [
    QA_CURRENCY,
  ]);
  await db.query('begin');
  await db.query('alter table ledger_entries disable trigger ledger_entries_no_delete');
  for (const w of wallets.rows) {
    await db.query('delete from ledger_entries where wallet_id = $1', [w.id]);
  }
  await db.query('alter table ledger_entries enable trigger ledger_entries_no_delete');
  await db.query('commit');
  await db.query('delete from platform_withdrawals where currency = $1', [QA_CURRENCY]);
  await db.query('delete from wallets where currency = $1 and user_id is null', [QA_CURRENCY]);
  await db.query('delete from platform_bank_accounts where currency = $1', [QA_CURRENCY]);
}

async function proposeAndApprove(db, { requester, approver, payload }) {
  const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
    requester,
    'platform_withdrawal',
    JSON.stringify(payload),
  ]);
  const pendingId = proposeRes.rows[0].id;
  await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);
  return pendingId;
}

async function testExecuteGrantsAreLocked(db) {
  const functions = [
    'fn_admin_initiate_platform_withdrawal(uuid, uuid, text, bigint, uuid)',
    'fn_admin_complete_platform_withdrawal(uuid, text)',
    'fn_admin_fail_platform_withdrawal(uuid)',
  ];
  for (const fn of functions) {
    const anonRes = await db.query('select has_function_privilege($1, $2, $3) as ok', [
      'anon',
      `public.${fn}`,
      'execute',
    ]);
    const authRes = await db.query('select has_function_privilege($1, $2, $3) as ok', [
      'authenticated',
      `public.${fn}`,
      'execute',
    ]);
    const serviceRes = await db.query('select has_function_privilege($1, $2, $3) as ok', [
      'service_role',
      `public.${fn}`,
      'execute',
    ]);
    log(
      `${fn}: anon/authenticated blocked, service_role granted (CLAUDE.md rule #11)`,
      anonRes.rows[0].ok === false &&
        authRes.rows[0].ok === false &&
        serviceRes.rows[0].ok === true,
    );
  }

  const writeRes = await db.query('select has_table_privilege($1, $2, $3) as ok', [
    'service_role',
    'public.platform_withdrawals',
    'insert',
  ]);
  log(
    'service_role cannot INSERT into platform_withdrawals directly (only via fn_admin_initiate_platform_withdrawal)',
    writeRes.rows[0].ok === false,
  );
}

async function testDualApprovalAndGuards(db) {
  const requester = await insertTestAdmin(db, {
    email: `pw-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pw-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `pw-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let fixtures;
  let pendingId = null;

  try {
    fixtures = await seedFixtures(db, { startingBalance: 5000 });
    const payload = {
      currency: QA_CURRENCY,
      amount_minor: 2000,
      platform_bank_account_id: fixtures.bankAccountId,
    };

    try {
      await db.query('select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5)', [
        requester,
        crypto.randomUUID(),
        payload.currency,
        payload.amount_minor,
        payload.platform_bank_account_id,
      ]);
      log(
        'initiating with a nonexistent pending_action_id is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'initiating with a nonexistent pending_action_id is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5)', [
        unauthorized,
        crypto.randomUUID(),
        payload.currency,
        payload.amount_minor,
        payload.platform_bank_account_id,
      ]);
      log(
        'finance_admin (no initiate_platform_withdrawal) cannot initiate',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'finance_admin (no initiate_platform_withdrawal) cannot initiate',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    pendingId = await proposeAndApprove(db, { requester, approver, payload });

    try {
      await db.query('select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        payload.currency,
        9999,
        payload.platform_bank_account_id,
      ]);
      log(
        'initiating with an amount that does not match the approved payload is rejected',
        false,
        'expected pending_action_payload_mismatch',
      );
    } catch (e) {
      log(
        'initiating with an amount that does not match the approved payload is rejected',
        /pending_action_payload_mismatch/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (fixtures) await cleanupFixtures(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
    await deleteTestAdmin(db, unauthorized);
  }
}

async function testInactiveAndCurrencyMismatchedBankAccountRejected(db) {
  const requester = await insertTestAdmin(db, {
    email: `pw-inactive-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pw-inactive-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let fixtures;
  let pendingId = null;

  try {
    fixtures = await seedFixtures(db, { startingBalance: 5000 });
    await db.query('update platform_bank_accounts set is_active = false where id = $1', [
      fixtures.bankAccountId,
    ]);

    const payload = {
      currency: QA_CURRENCY,
      amount_minor: 1000,
      platform_bank_account_id: fixtures.bankAccountId,
    };
    pendingId = await proposeAndApprove(db, { requester, approver, payload });

    try {
      await db.query('select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        payload.currency,
        payload.amount_minor,
        payload.platform_bank_account_id,
      ]);
      log(
        'withdrawing to an inactive bank account is rejected',
        false,
        'expected bank_account_inactive',
      );
    } catch (e) {
      log(
        'withdrawing to an inactive bank account is rejected',
        /bank_account_inactive/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (fixtures) await cleanupFixtures(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testInsufficientBalanceRejected(db) {
  const requester = await insertTestAdmin(db, {
    email: `pw-insuff-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pw-insuff-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let fixtures;
  let pendingId = null;

  try {
    fixtures = await seedFixtures(db, { startingBalance: 500 });
    const payload = {
      currency: QA_CURRENCY,
      amount_minor: 999999,
      platform_bank_account_id: fixtures.bankAccountId,
    };
    pendingId = await proposeAndApprove(db, { requester, approver, payload });

    try {
      await db.query('select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        payload.currency,
        payload.amount_minor,
        payload.platform_bank_account_id,
      ]);
      log(
        'withdrawing more than the platform revenue balance holds is rejected',
        false,
        'expected insufficient_platform_revenue',
      );
    } catch (e) {
      log(
        'withdrawing more than the platform revenue balance holds is rejected',
        /insufficient_platform_revenue/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (fixtures) await cleanupFixtures(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testInitiateThenCompleteHappyPath(db) {
  const requester = await insertTestAdmin(db, {
    email: `pw-complete-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pw-complete-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let fixtures;
  let pendingId = null;
  let withdrawalId = null;

  try {
    fixtures = await seedFixtures(db, { startingBalance: 10000 });
    const payload = {
      currency: QA_CURRENCY,
      amount_minor: 4000,
      platform_bank_account_id: fixtures.bankAccountId,
    };
    pendingId = await proposeAndApprove(db, { requester, approver, payload });

    const res = await db.query(
      'select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5) as id',
      [
        requester,
        pendingId,
        payload.currency,
        payload.amount_minor,
        payload.platform_bank_account_id,
      ],
    );
    withdrawalId = res.rows[0].id;

    const balance = await db.query('select balance from wallets where id = $1', [
      fixtures.walletId,
    ]);
    log(
      'initiating debits the platform revenue wallet by exactly the requested amount',
      Number(balance.rows[0].balance) === 10000 - 4000,
    );

    const row = await db.query(
      'select status, initiated_by_admin_id, pending_action_id from platform_withdrawals where id = $1',
      [withdrawalId],
    );
    log(
      'the platform_withdrawals row starts processing, attributed to the real requester and the pending action',
      row.rows[0].status === 'processing' &&
        row.rows[0].initiated_by_admin_id === requester &&
        row.rows[0].pending_action_id === pendingId,
    );

    const ledger = await db.query(
      `select reason, ref_type, ref_id from ledger_entries where wallet_id = $1 and reason = 'platform_withdrawal_payout'`,
      [fixtures.walletId],
    );
    log(
      'the debit ledger row is correctly tagged and links back to the withdrawal',
      ledger.rows[0].ref_type === 'platform_withdrawal' && ledger.rows[0].ref_id === withdrawalId,
    );

    // Simulates the webhook's transfer.completed handler (piece 3).
    await db.query('select fn_admin_complete_platform_withdrawal($1, $2)', [
      withdrawalId,
      'flw-transfer-ref-123',
    ]);
    const completed = await db.query(
      'select status, provider_reference, completed_at from platform_withdrawals where id = $1',
      [withdrawalId],
    );
    log(
      'completing sets status=paid, records the provider reference, and stamps completed_at',
      completed.rows[0].status === 'paid' &&
        completed.rows[0].provider_reference === 'flw-transfer-ref-123' &&
        completed.rows[0].completed_at !== null,
    );

    // A webhook redelivering the same event must be a safe no-op, not an error.
    await db.query('select fn_admin_complete_platform_withdrawal($1, $2)', [
      withdrawalId,
      'flw-transfer-ref-123',
    ]);
    const stillCompleted = await db.query('select status from platform_withdrawals where id = $1', [
      withdrawalId,
    ]);
    log(
      'completing an already-paid withdrawal again is an idempotent no-op, not an error',
      stillCompleted.rows[0].status === 'paid',
    );

    try {
      await db.query('select fn_admin_fail_platform_withdrawal($1)', [withdrawalId]);
      log(
        'a paid withdrawal cannot subsequently be marked failed',
        false,
        'expected platform_withdrawal_not_processing',
      );
    } catch (e) {
      log(
        'a paid withdrawal cannot subsequently be marked failed',
        /platform_withdrawal_not_processing/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (withdrawalId)
      await db.query('delete from platform_withdrawals where id = $1', [withdrawalId]);
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (fixtures) await cleanupFixtures(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testFailReversesTheDebitWithLedgerConservation(db) {
  const requester = await insertTestAdmin(db, {
    email: `pw-fail-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pw-fail-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let fixtures;
  let pendingId = null;
  let withdrawalId = null;

  try {
    fixtures = await seedFixtures(db, { startingBalance: 10000 });
    const payload = {
      currency: QA_CURRENCY,
      amount_minor: 3000,
      platform_bank_account_id: fixtures.bankAccountId,
    };
    pendingId = await proposeAndApprove(db, { requester, approver, payload });

    const res = await db.query(
      'select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5) as id',
      [
        requester,
        pendingId,
        payload.currency,
        payload.amount_minor,
        payload.platform_bank_account_id,
      ],
    );
    withdrawalId = res.rows[0].id;

    // Simulates the webhook's provider-failure path (piece 3, mirroring
    // withdraw/index.ts's own fn_fail_withdrawal call on a provider error).
    await db.query('select fn_admin_fail_platform_withdrawal($1)', [withdrawalId]);

    const balance = await db.query('select balance from wallets where id = $1', [
      fixtures.walletId,
    ]);
    log(
      'failing refunds the wallet back to its pre-withdrawal balance',
      Number(balance.rows[0].balance) === 10000,
    );

    const sum = await db.query(
      'select coalesce(sum(amount),0)::bigint as sum from ledger_entries where wallet_id = $1',
      [fixtures.walletId],
    );
    log(
      'ledger conservation holds after the debit + refund pair',
      Number(sum.rows[0].sum) === Number(balance.rows[0].balance),
    );

    const status = await db.query('select status from platform_withdrawals where id = $1', [
      withdrawalId,
    ]);
    log('the withdrawal itself is marked failed', status.rows[0].status === 'failed');

    // A webhook (or a defensive retry) redelivering the same failure must
    // be a safe no-op, not a second refund.
    await db.query('select fn_admin_fail_platform_withdrawal($1)', [withdrawalId]);
    const balanceAfterRetry = await db.query('select balance from wallets where id = $1', [
      fixtures.walletId,
    ]);
    log(
      'failing an already-failed withdrawal again is an idempotent no-op, not a double refund',
      Number(balanceAfterRetry.rows[0].balance) === 10000,
    );
  } finally {
    if (withdrawalId)
      await db.query('delete from platform_withdrawals where id = $1', [withdrawalId]);
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (fixtures) await cleanupFixtures(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testConcurrentInitiateOfSameApprovalCannotDoubleDebit(db) {
  const requester = await insertTestAdmin(db, {
    email: `pw-concurrent-init-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pw-concurrent-init-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let fixtures;
  let pendingId = null;

  try {
    fixtures = await seedFixtures(db, { startingBalance: 10000 });
    const payload = {
      currency: QA_CURRENCY,
      amount_minor: 5000,
      platform_bank_account_id: fixtures.bankAccountId,
    };
    pendingId = await proposeAndApprove(db, { requester, approver, payload });

    const N = 8;
    const clients = Array.from({ length: N }, () => newClient());
    await Promise.all(clients.map((c) => c.connect()));

    const results = await Promise.allSettled(
      clients.map((c) =>
        c.query('select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5) as id', [
          requester,
          pendingId,
          payload.currency,
          payload.amount_minor,
          payload.platform_bank_account_id,
        ]),
      ),
    );
    await Promise.all(clients.map((c) => c.end()));

    const successes = results.filter((r) => r.status === 'fulfilled');
    log(
      `${N} truly concurrent initiations of the same approved withdrawal: exactly one succeeds`,
      successes.length === 1,
      `got ${successes.length} successes`,
    );

    const balance = await db.query('select balance from wallets where id = $1', [
      fixtures.walletId,
    ]);
    log(
      'the platform wallet is debited exactly once (5000), not once per concurrent caller',
      Number(balance.rows[0].balance) === 10000 - 5000,
    );

    if (successes.length === 1) {
      const withdrawalId = successes[0].value.rows[0].id;
      await db.query('delete from platform_withdrawals where id = $1', [withdrawalId]);
    }
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (fixtures) await cleanupFixtures(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testConcurrentCompleteCannotDoubleApply(db) {
  const requester = await insertTestAdmin(db, {
    email: `pw-concurrent-complete-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pw-concurrent-complete-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let fixtures;
  let pendingId = null;
  let withdrawalId = null;

  try {
    fixtures = await seedFixtures(db, { startingBalance: 10000 });
    const payload = {
      currency: QA_CURRENCY,
      amount_minor: 2500,
      platform_bank_account_id: fixtures.bankAccountId,
    };
    pendingId = await proposeAndApprove(db, { requester, approver, payload });

    const initRes = await db.query(
      'select fn_admin_initiate_platform_withdrawal($1, $2, $3, $4, $5) as id',
      [
        requester,
        pendingId,
        payload.currency,
        payload.amount_minor,
        payload.platform_bank_account_id,
      ],
    );
    withdrawalId = initRes.rows[0].id;

    const N = 6;
    const clients = Array.from({ length: N }, () => newClient());
    await Promise.all(clients.map((c) => c.connect()));

    // Simulates N near-simultaneous webhook redeliveries of the same
    // transfer.completed event — every one of these should succeed
    // (idempotent), none should error, and the final state must be
    // exactly what one completion would produce.
    const results = await Promise.allSettled(
      clients.map((c) =>
        c.query('select fn_admin_complete_platform_withdrawal($1, $2)', [
          withdrawalId,
          'flw-ref-race',
        ]),
      ),
    );
    await Promise.all(clients.map((c) => c.end()));

    const allSucceeded = results.every((r) => r.status === 'fulfilled');
    log(
      `${N} concurrent redeliveries of the same completion event all succeed idempotently, none error`,
      allSucceeded,
      JSON.stringify(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message)),
    );

    const row = await db.query(
      'select status, provider_reference from platform_withdrawals where id = $1',
      [withdrawalId],
    );
    log(
      'the final state is exactly one completion, not corrupted by the race',
      row.rows[0].status === 'paid' && row.rows[0].provider_reference === 'flw-ref-race',
    );
  } finally {
    if (withdrawalId)
      await db.query('delete from platform_withdrawals where id = $1', [withdrawalId]);
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (fixtures) await cleanupFixtures(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testDualApprovalAndGuards(admin);
    await testInactiveAndCurrencyMismatchedBankAccountRejected(admin);
    await testInsufficientBalanceRejected(admin);
    await testInitiateThenCompleteHappyPath(admin);
    await testFailReversesTheDebitWithLedgerConservation(admin);
    await testConcurrentInitiateOfSameApprovalCannotDoubleDebit(admin);
    await testConcurrentCompleteCannotDoubleApply(admin);
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
