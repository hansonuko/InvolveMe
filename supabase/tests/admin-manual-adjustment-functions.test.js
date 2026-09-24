#!/usr/bin/env node
// Admin dashboard Phase E piece 2 — DB-level tests for
// fn_admin_post_manual_adjustment (20260923110000_admin_pricing_dual_
// approval_and_manual_adjustment.sql), the first-ever function in this
// codebase that lets an admin post a manual ledger adjustment. Same
// pattern as wallet-functions.test.js for user/wallet fixtures (real
// pg.Client, fresh random users, self-cleaning) and admin-dual-approval-
// functions.test.js for admin fixtures.
//
// This function mutates a real wallet balance, so per CLAUDE.md's own
// rule it needs both a ledger-conservation assertion and a concurrency
// assertion, not just the generic single-use-consume coverage piece 1's
// suite already has for the dual-approval engine in the abstract. A
// manual adjustment is deliberately single-entry (it corrects what one
// wallet's ledger should have read, not a transfer between two wallets),
// so "conservation" here means wallet.balance stays exactly
// sum(ledger_entries) for that wallet — the same invariant
// ledger_entries_apply_to_wallet already guarantees by construction —
// and that a real concurrent double-apply of the same approval cannot
// double the effect.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-manual-adjustment` from the repo root.',
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
  await db.query('alter table admin_audit_log disable trigger admin_audit_log_no_delete');
  await db.query('delete from admin_audit_log where admin_user_id = $1', [id]);
  await db.query('alter table admin_audit_log enable trigger admin_audit_log_no_delete');
  await db.query('delete from admin_users where id = $1', [id]);
}

// Same pattern as wallet-functions.test.js: inserting into auth.users
// fires this project's existing onboarding trigger, which creates the
// user's three wallets (topup_credit/earnings_pending/withdrawable_cash)
// automatically.
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

async function deleteTestUser(admin, id) {
  admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function walletRow(admin, userId, kind) {
  const r = await admin.query(
    'select id, balance, currency from public.wallets where user_id=$1 and kind=$2',
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

async function proposeAndApprove(db, { requester, approver, wallet_id, amount, note }) {
  const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
    requester,
    'manual_ledger_adjustment',
    JSON.stringify({ wallet_id, amount, note }),
  ]);
  const pendingId = proposeRes.rows[0].id;
  await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);
  return pendingId;
}

async function testExecuteGrantsAreLocked(db) {
  const fn = 'fn_admin_post_manual_adjustment(uuid, uuid, uuid, bigint, text)';
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
    anonRes.rows[0].ok === false && authRes.rows[0].ok === false && serviceRes.rows[0].ok === true,
  );
}

async function testRequiresApprovedPendingAction(db) {
  const requester = await insertTestAdmin(db, {
    email: `manual-adj-req1-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const targetUserId = await createTestUser(db);

  try {
    const wallet = await walletRow(db, targetUserId, 'topup_credit');

    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        requester,
        crypto.randomUUID(),
        wallet.id,
        100,
        'never proposed',
      ]);
      log(
        'a nonexistent pending_action_id is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'a nonexistent pending_action_id is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requester,
      'manual_ledger_adjustment',
      JSON.stringify({ wallet_id: wallet.id, amount: 100, note: 'still pending' }),
    ]);
    const pendingId = proposeRes.rows[0].id;

    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        wallet.id,
        100,
        'still pending',
      ]);
      log(
        'an unapproved (still-pending) action cannot be applied',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'an unapproved (still-pending) action cannot be applied',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
  } finally {
    await deleteTestUser(db, targetUserId);
    await deleteTestAdmin(db, requester);
  }
}

async function testUnauthorizedActorCannotApplyEvenWithValidApproval(db) {
  const requester = await insertTestAdmin(db, {
    email: `manual-adj-req2-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `manual-adj-appr2-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `manual-adj-unauth2-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  const targetUserId = await createTestUser(db);
  let pendingId = null;

  try {
    const wallet = await walletRow(db, targetUserId, 'topup_credit');
    pendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: 100,
      note: 'authorized only',
    });

    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        unauthorized,
        pendingId,
        wallet.id,
        100,
        'authorized only',
      ]);
      log(
        'an admin without post_manual_adjustment cannot apply, even with a valid matching approval',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'an admin without post_manual_adjustment cannot apply, even with a valid matching approval',
        /not_authorized/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await deleteTestUser(db, targetUserId);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
    await deleteTestAdmin(db, unauthorized);
  }
}

async function testGuards(db) {
  const requester = await insertTestAdmin(db, {
    email: `manual-adj-req3-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `manual-adj-appr3-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const targetUserId = await createTestUser(db);
  let pendingId = null;

  try {
    const wallet = await walletRow(db, targetUserId, 'topup_credit');

    pendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: 0,
      note: 'zero',
    });
    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        wallet.id,
        0,
        'zero',
      ]);
      log('a zero amount is rejected', false, 'expected invalid_amount');
    } catch (e) {
      log('a zero amount is rejected', /invalid_amount/.test(e.message), e.message);
    }
    await db.query('delete from admin_pending_actions where id = $1', [pendingId]);

    pendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: 50,
      note: '',
    });
    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        wallet.id,
        50,
        '',
      ]);
      log('an empty note is rejected', false, 'expected note_required');
    } catch (e) {
      log('an empty note is rejected', /note_required/.test(e.message), e.message);
    }
    await db.query('delete from admin_pending_actions where id = $1', [pendingId]);

    pendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: 50,
      note: 'mismatch test',
    });
    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        wallet.id,
        999,
        'mismatch test',
      ]);
      log(
        'an amount that does not match the approved payload is rejected',
        false,
        'expected pending_action_payload_mismatch',
      );
    } catch (e) {
      log(
        'an amount that does not match the approved payload is rejected',
        /pending_action_payload_mismatch/.test(e.message),
        e.message,
      );
    }
    pendingId = null; // already consumed by the mismatch attempt (fail-closed, single-use — see migration header comment)

    const bigDebit = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: -999999999,
      note: 'would go negative',
    });
    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        requester,
        bigDebit,
        wallet.id,
        -999999999,
        'would go negative',
      ]);
      log(
        'a debit larger than the wallet balance is rejected',
        false,
        'expected insufficient_balance_for_adjustment',
      );
    } catch (e) {
      log(
        'a debit larger than the wallet balance is rejected',
        /insufficient_balance_for_adjustment/.test(e.message),
        e.message,
      );
    }
    await db.query('delete from admin_pending_actions where id = $1', [bigDebit]);
  } finally {
    await deleteTestUser(db, targetUserId);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testFrozenWalletRejected(db) {
  const requester = await insertTestAdmin(db, {
    email: `manual-adj-req4-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `manual-adj-appr4-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  // fn_admin_set_wallet_frozen is gated on resolve_fraud_signal, which
  // finance_admin does not hold — a separate super_admin fixture freezes/
  // unfreezes here, distinct from the finance_admin pair driving the
  // manual-adjustment propose/approve flow under test.
  const freezer = await insertTestAdmin(db, {
    email: `manual-adj-freezer4-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const targetUserId = await createTestUser(db);
  let pendingId = null;
  let walletId = null;

  try {
    const wallet = await walletRow(db, targetUserId, 'topup_credit');
    walletId = wallet.id;
    await db.query('select fn_admin_set_wallet_frozen($1, $2, $3, $4)', [
      freezer,
      wallet.id,
      true,
      'test freeze',
    ]);

    pendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: 100,
      note: 'on a frozen wallet',
    });
    try {
      await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
        requester,
        pendingId,
        wallet.id,
        100,
        'on a frozen wallet',
      ]);
      log('an adjustment on a frozen wallet is rejected', false, 'expected wallet_frozen');
    } catch (e) {
      log(
        'an adjustment on a frozen wallet is rejected',
        /wallet_frozen/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (walletId) {
      await db.query('select fn_admin_set_wallet_frozen($1, $2, $3, $4)', [
        freezer,
        walletId,
        false,
        'test cleanup',
      ]);
    }
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await deleteTestUser(db, targetUserId);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
    await deleteTestAdmin(db, freezer);
  }
}

async function testAppliesCreditAndDebitWithLedgerConservation(db) {
  const requester = await insertTestAdmin(db, {
    email: `manual-adj-req5-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `manual-adj-appr5-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const targetUserId = await createTestUser(db);
  let creditPendingId = null;
  let debitPendingId = null;

  try {
    const wallet = await walletRow(db, targetUserId, 'topup_credit');
    const startingBalance = wallet.balance;

    creditPendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: 500,
      note: 'correcting an under-credit',
    });
    const creditEntryRes = await db.query(
      'select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5) as id',
      [requester, creditPendingId, wallet.id, 500, 'correcting an under-credit'],
    );
    const creditEntryId = creditEntryRes.rows[0].id;

    let row = await db.query('select balance from wallets where id = $1', [wallet.id]);
    log(
      'a +500 manual credit increases the wallet balance by exactly 500',
      Number(row.rows[0].balance) === Number(startingBalance) + 500,
    );

    const entry = await db.query(
      'select amount, reason, ref_type, ref_id, currency, created_by from ledger_entries where id = $1',
      [creditEntryId],
    );
    const requesterEmail = (
      await db.query('select email from admin_users where id = $1', [requester])
    ).rows[0].email;
    log(
      'the ledger_entries row is correctly attributed: reason=manual_adjustment, ref_type=admin_action pointing at the pending action, currency from the wallet, created_by the real admin email',
      entry.rows[0].reason === 'manual_adjustment' &&
        entry.rows[0].ref_type === 'admin_action' &&
        entry.rows[0].ref_id === creditPendingId &&
        entry.rows[0].currency === wallet.currency &&
        entry.rows[0].created_by === requesterEmail,
      JSON.stringify(entry.rows[0]),
    );

    debitPendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: -200,
      note: 'correcting an over-credit',
    });
    await db.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
      requester,
      debitPendingId,
      wallet.id,
      -200,
      'correcting an over-credit',
    ]);

    row = await db.query('select balance from wallets where id = $1', [wallet.id]);
    log(
      'a subsequent -200 manual debit decreases the balance by exactly 200',
      Number(row.rows[0].balance) === Number(startingBalance) + 500 - 200,
    );

    const sum = await ledgerSum(db, wallet.id);
    log(
      'ledger conservation holds: wallet.balance equals sum(ledger_entries) for this wallet after both adjustments',
      Number(row.rows[0].balance) === sum,
      `balance=${row.rows[0].balance} ledgerSum=${sum}`,
    );
  } finally {
    if (creditPendingId)
      await db.query('delete from admin_pending_actions where id = $1', [creditPendingId]);
    if (debitPendingId)
      await db.query('delete from admin_pending_actions where id = $1', [debitPendingId]);
    await deleteTestUser(db, targetUserId);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testConcurrentApplyOfSameApprovalCannotDoubleCredit(db) {
  const requester = await insertTestAdmin(db, {
    email: `manual-adj-req6-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `manual-adj-appr6-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const targetUserId = await createTestUser(db);
  let pendingId = null;

  try {
    const wallet = await walletRow(db, targetUserId, 'topup_credit');
    const startingBalance = wallet.balance;
    pendingId = await proposeAndApprove(db, {
      requester,
      approver,
      wallet_id: wallet.id,
      amount: 1000,
      note: 'concurrency race',
    });

    const N = 8;
    const clients = Array.from({ length: N }, () => newClient());
    await Promise.all(clients.map((c) => c.connect()));

    const results = await Promise.allSettled(
      clients.map((c) =>
        c.query('select fn_admin_post_manual_adjustment($1, $2, $3, $4, $5)', [
          requester,
          pendingId,
          wallet.id,
          1000,
          'concurrency race',
        ]),
      ),
    );
    await Promise.all(clients.map((c) => c.end()));

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    log(
      `${N} truly concurrent applies of the same approval: exactly one succeeds`,
      successes === 1,
      `got ${successes} successes`,
    );

    const row = await db.query('select balance from wallets where id = $1', [wallet.id]);
    log(
      'the wallet is only credited once (1000), not once per concurrent caller — no double-spend',
      Number(row.rows[0].balance) === Number(startingBalance) + 1000,
      `balance=${row.rows[0].balance} starting=${startingBalance}`,
    );

    const sum = await ledgerSum(db, wallet.id);
    log(
      'ledger conservation holds under the concurrent race too',
      Number(row.rows[0].balance) === sum,
    );
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await deleteTestUser(db, targetUserId);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testRequiresApprovedPendingAction(admin);
    await testUnauthorizedActorCannotApplyEvenWithValidApproval(admin);
    await testGuards(admin);
    await testFrozenWalletRejected(admin);
    await testAppliesCreditAndDebitWithLedgerConservation(admin);
    await testConcurrentApplyOfSameApprovalCannotDoubleCredit(admin);
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
