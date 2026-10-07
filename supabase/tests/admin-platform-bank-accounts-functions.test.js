#!/usr/bin/env node
// Admin dashboard Phase F piece 1 — DB-level tests for
// 20260924090000_platform_bank_accounts_and_earnings_conversion.sql. Same
// pattern as admin-dual-approval-functions.test.js /
// admin-manual-adjustment-functions.test.js: real pg.Client against the
// real linked dev database, fresh random fixtures per run, self-cleaning.
//
// Covers: registering a platform_bank_accounts row genuinely requires
// dual approval (unlike deactivating one, which is single-admin —
// confirmed both ways, not just the happy path); the payload-match guard
// on registration; deactivation is idempotent-safe (can't deactivate
// twice); and fn_admin_convert_platform_earnings_to_cash — ledger
// conservation across the two-wallet conversion pair, the insufficient-
// balance guard, and a real concurrency race proving two simultaneous
// conversions can't double-spend the same earnings balance (this
// function mutates real platform wallet balances, so per CLAUDE.md it
// needs both, not just the generic single-use-consume coverage the
// dual-approval engine's own suite already has).
//
// Uses a disposable currency tag (QACUR) for its own platform wallet
// pair, created fresh and torn down each run, so nothing here ever
// touches the real NGN platform wallets' live balances.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-platform-bank-accounts` from the repo root.',
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

async function proposeAndApprove(db, { requester, approver, actionType, payload }) {
  const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
    requester,
    actionType,
    JSON.stringify(payload),
  ]);
  const pendingId = proposeRes.rows[0].id;
  await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);
  return pendingId;
}

async function testExecuteGrantsAreLocked(db) {
  const functions = [
    'fn_admin_register_platform_bank_account(uuid, uuid, text, text, text, text, text, text)',
    'fn_admin_deactivate_platform_bank_account(uuid, uuid)',
    'fn_admin_convert_platform_earnings_to_cash(uuid, text, bigint)',
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
    'public.platform_bank_accounts',
    'insert',
  ]);
  log(
    'service_role cannot INSERT into platform_bank_accounts directly (only via fn_admin_register_platform_bank_account)',
    writeRes.rows[0].ok === false,
  );
}

async function testRegistrationRequiresDualApproval(db) {
  const requester = await insertTestAdmin(db, {
    email: `bankacct-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let pendingId = null;
  let bankAccountId = null;

  const payload = {
    currency: 'NGN',
    bank_name: 'Test Bank',
    account_number_last4: '1234',
    provider_account_id: `prov-${crypto.randomUUID()}`,
    account_name: 'InvolveMe Ltd',
    label: 'Primary NGN account',
  };

  try {
    try {
      await db.query(
        'select fn_admin_register_platform_bank_account($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          requester,
          crypto.randomUUID(),
          payload.currency,
          payload.bank_name,
          payload.account_number_last4,
          payload.provider_account_id,
          payload.account_name,
          payload.label,
        ],
      );
      log(
        'registering with a nonexistent pending_action_id is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'registering with a nonexistent pending_action_id is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requester,
      'platform_bank_account_registration',
      JSON.stringify(payload),
    ]);
    pendingId = proposeRes.rows[0].id;

    try {
      await db.query(
        'select fn_admin_register_platform_bank_account($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          requester,
          pendingId,
          payload.currency,
          payload.bank_name,
          payload.account_number_last4,
          payload.provider_account_id,
          payload.account_name,
          payload.label,
        ],
      );
      log(
        'registering against an unapproved (still-pending) proposal is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'registering against an unapproved (still-pending) proposal is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [requester, pendingId]);
      log(
        'the requester cannot approve their own bank-account registration',
        false,
        'expected cannot_approve_own_action',
      );
    } catch (e) {
      log(
        'the requester cannot approve their own bank-account registration',
        /cannot_approve_own_action/.test(e.message),
        e.message,
      );
    }

    const approver = await insertTestAdmin(db, {
      email: `bankacct-appr-${crypto.randomUUID()}@test.invalid`,
      roleNames: ['super_admin'],
    });
    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);

      try {
        await db.query(
          'select fn_admin_register_platform_bank_account($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            requester,
            pendingId,
            payload.currency,
            payload.bank_name,
            payload.account_number_last4,
            payload.provider_account_id,
            'A Different Name Than Approved',
            payload.label,
          ],
        );
        log(
          'registering with a value that does not match the approved payload is rejected',
          false,
          'expected pending_action_payload_mismatch',
        );
      } catch (e) {
        log(
          'registering with a value that does not match the approved payload is rejected',
          /pending_action_payload_mismatch/.test(e.message),
          e.message,
        );
      }

      const res = await db.query(
        'select fn_admin_register_platform_bank_account($1, $2, $3, $4, $5, $6, $7, $8) as id',
        [
          requester,
          pendingId,
          payload.currency,
          payload.bank_name,
          payload.account_number_last4,
          payload.provider_account_id,
          payload.account_name,
          payload.label,
        ],
      );
      bankAccountId = res.rows[0].id;
      log('a matching approved registration succeeds', !!bankAccountId);

      const row = await db.query(
        'select added_by_admin_id, is_active from platform_bank_accounts where id = $1',
        [bankAccountId],
      );
      log(
        'the new row is attributed to the real requester and starts active',
        row.rows[0].added_by_admin_id === requester && row.rows[0].is_active === true,
      );
    } finally {
      await deleteTestAdmin(db, approver);
    }
  } finally {
    if (bankAccountId)
      await db.query('delete from platform_bank_accounts where id = $1', [bankAccountId]);
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await deleteTestAdmin(db, requester);
  }
}

async function testDeactivationIsSingleAdmin(db) {
  const requester = await insertTestAdmin(db, {
    email: `bankacct-deact-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const deactivator = await insertTestAdmin(db, {
    email: `bankacct-deact-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `bankacct-deact-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;
  let bankAccountId = null;

  const payload = {
    currency: 'NGN',
    bank_name: 'Test Bank 2',
    account_number_last4: '5678',
    provider_account_id: `prov-${crypto.randomUUID()}`,
    account_name: 'InvolveMe Ltd',
    label: null,
  };

  try {
    pendingId = await proposeAndApprove(db, {
      requester,
      approver: deactivator,
      actionType: 'platform_bank_account_registration',
      payload,
    });
    const res = await db.query(
      'select fn_admin_register_platform_bank_account($1, $2, $3, $4, $5, $6, $7, $8) as id',
      [
        requester,
        pendingId,
        payload.currency,
        payload.bank_name,
        payload.account_number_last4,
        payload.provider_account_id,
        payload.account_name,
        payload.label,
      ],
    );
    bankAccountId = res.rows[0].id;

    try {
      await db.query('select fn_admin_deactivate_platform_bank_account($1, $2)', [
        unauthorized,
        bankAccountId,
      ]);
      log(
        'finance_admin (no manage_platform_bank_accounts) cannot deactivate',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'finance_admin (no manage_platform_bank_accounts) cannot deactivate',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    // Deliberately no propose/approve here — deactivation is single-admin by design.
    await db.query('select fn_admin_deactivate_platform_bank_account($1, $2)', [
      deactivator,
      bankAccountId,
    ]);
    const row = await db.query(
      'select is_active, deactivated_by_admin_id from platform_bank_accounts where id = $1',
      [bankAccountId],
    );
    log(
      'a single super_admin can deactivate without any dual-approval step',
      row.rows[0].is_active === false && row.rows[0].deactivated_by_admin_id === deactivator,
    );

    try {
      await db.query('select fn_admin_deactivate_platform_bank_account($1, $2)', [
        deactivator,
        bankAccountId,
      ]);
      log(
        'deactivating an already-inactive account is rejected, not a silent no-op',
        false,
        'expected bank_account_not_found_or_already_inactive',
      );
    } catch (e) {
      log(
        'deactivating an already-inactive account is rejected, not a silent no-op',
        /bank_account_not_found_or_already_inactive/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (bankAccountId)
      await db.query('delete from platform_bank_accounts where id = $1', [bankAccountId]);
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, deactivator);
    await deleteTestAdmin(db, unauthorized);
  }
}

const QA_CURRENCY = 'QACUR';

// Seeds the earnings-cut wallet's starting balance THROUGH a ledger_entries
// row (reason 'manual_adjustment', the closest existing "arbitrary fixture
// value" reason), not a raw balance UPDATE — a raw UPDATE would violate
// CLAUDE.md rule #4 (balance is derived from ledger_entries, never written
// directly) for this wallet's own starting state, which is exactly the
// invariant testConvertEarningsToCash's own conservation assertion below
// checks. wallets.balance is left at its column default (0) on insert; the
// ledger_entries_apply_to_wallet trigger brings it to 10000 from there.
async function seedQaPlatformWallets(db) {
  const earningsWallet = await db.query(
    `insert into wallets (kind, currency, user_id) values ('platform_revenue_earnings_cut', $1, null)
     on conflict (kind, currency) where user_id is null do update set currency = excluded.currency
     returning id`,
    [QA_CURRENCY],
  );
  await db.query(
    `insert into wallets (kind, currency, user_id) values ('platform_revenue_topup_fees', $1, null)
     on conflict (kind, currency) where user_id is null do update set currency = excluded.currency`,
    [QA_CURRENCY],
  );
  await db.query(
    `insert into ledger_entries (wallet_id, amount, reason, ref_type, currency) values ($1, 10000, 'manual_adjustment', 'admin_action', $2)`,
    [earningsWallet.rows[0].id, QA_CURRENCY],
  );
  await db.query(
    `insert into pricing_config (key, currency, value, description) values ('credit_unit_kobo', $1, 1000, 'QA fixture') on conflict (key, currency) do update set value = 1000`,
    [QA_CURRENCY],
  );
}

async function cleanupQaPlatformWallets(db) {
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
  await db.query('delete from wallets where currency = $1 and user_id is null', [QA_CURRENCY]);
  await db.query('delete from pricing_config_history where key = $1 and currency = $2', [
    'credit_unit_kobo',
    QA_CURRENCY,
  ]);
  await db.query('delete from pricing_config where key = $1 and currency = $2', [
    'credit_unit_kobo',
    QA_CURRENCY,
  ]);
}

async function testConvertEarningsToCash(db) {
  const admin = await insertTestAdmin(db, {
    email: `convert-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `convert-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['content_moderator'],
  });

  try {
    await seedQaPlatformWallets(db);

    try {
      await db.query('select fn_admin_convert_platform_earnings_to_cash($1, $2, $3)', [
        unauthorized,
        QA_CURRENCY,
        100,
      ]);
      log(
        'content_moderator (no initiate_platform_withdrawal) cannot convert',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'content_moderator (no initiate_platform_withdrawal) cannot convert',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_convert_platform_earnings_to_cash($1, $2, $3)', [
        admin,
        QA_CURRENCY,
        0,
      ]);
      log('a zero credit amount is rejected', false, 'expected invalid_amount');
    } catch (e) {
      log('a zero credit amount is rejected', /invalid_amount/.test(e.message), e.message);
    }

    try {
      await db.query('select fn_admin_convert_platform_earnings_to_cash($1, $2, $3)', [
        admin,
        QA_CURRENCY,
        999999,
      ]);
      log(
        'converting more credits than the platform earnings-cut balance holds is rejected',
        false,
        'expected insufficient_platform_earnings_balance',
      );
    } catch (e) {
      log(
        'converting more credits than the platform earnings-cut balance holds is rejected',
        /insufficient_platform_earnings_balance/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_convert_platform_earnings_to_cash($1, $2, $3)', [
      admin,
      QA_CURRENCY,
      4000,
    ]);

    const earnings = await db.query(
      `select balance from wallets where kind = 'platform_revenue_earnings_cut' and currency = $1 and user_id is null`,
      [QA_CURRENCY],
    );
    const cash = await db.query(
      `select balance from wallets where kind = 'platform_revenue_topup_fees' and currency = $1 and user_id is null`,
      [QA_CURRENCY],
    );
    log(
      'the earnings-cut wallet is debited by exactly the converted credits',
      Number(earnings.rows[0].balance) === 10000 - 4000,
    );
    log(
      'the topup-fees (cash) wallet is credited by credits * credit_unit_kobo',
      Number(cash.rows[0].balance) === 4000 * 1000,
    );

    const earningsSum = await db.query(
      `select coalesce(sum(amount),0)::bigint as sum from ledger_entries where wallet_id = (select id from wallets where kind='platform_revenue_earnings_cut' and currency=$1 and user_id is null)`,
      [QA_CURRENCY],
    );
    const cashSum = await db.query(
      `select coalesce(sum(amount),0)::bigint as sum from ledger_entries where wallet_id = (select id from wallets where kind='platform_revenue_topup_fees' and currency=$1 and user_id is null)`,
      [QA_CURRENCY],
    );
    log(
      'ledger conservation holds on both sides of the conversion pair',
      Number(earningsSum.rows[0].sum) === Number(earnings.rows[0].balance) &&
        Number(cashSum.rows[0].sum) === Number(cash.rows[0].balance),
    );

    // Excludes the seed fixture's own 'manual_adjustment' entry
    // (seedQaPlatformWallets) — this checks only the rows the conversion
    // call itself wrote.
    const conversionRows = await db.query(
      `select reason, ref_type, amount from ledger_entries where currency = $1 and reason = 'platform_earnings_conversion' order by amount`,
      [QA_CURRENCY],
    );
    log(
      'the conversion writes exactly one debit and one credit, both sharing the platform_earnings_conversion reason and admin_action ref_type',
      conversionRows.rows.length === 2 &&
        conversionRows.rows.every((r) => r.ref_type === 'admin_action') &&
        Number(conversionRows.rows[0].amount) === -4000 &&
        Number(conversionRows.rows[1].amount) === 4000 * 1000,
      JSON.stringify(conversionRows.rows),
    );
  } finally {
    await cleanupQaPlatformWallets(db);
    await deleteTestAdmin(db, admin);
    await deleteTestAdmin(db, unauthorized);
  }
}

async function testConcurrentConvertCannotDoubleSpendEarnings(db) {
  const admin = await insertTestAdmin(db, {
    email: `convert-concurrent-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });

  try {
    await seedQaPlatformWallets(db);
    // Trim the seeded 10000 down to exactly enough for ONE 6000-credit
    // conversion, not two — through the ledger, same reasoning as
    // seedQaPlatformWallets itself, not a raw balance UPDATE.
    const earningsWalletId = (
      await db.query(
        `select id from wallets where kind = 'platform_revenue_earnings_cut' and currency = $1 and user_id is null`,
        [QA_CURRENCY],
      )
    ).rows[0].id;
    await db.query(
      `insert into ledger_entries (wallet_id, amount, reason, ref_type, currency) values ($1, -4000, 'manual_adjustment', 'admin_action', $2)`,
      [earningsWalletId, QA_CURRENCY],
    );

    const N = 6;
    const clients = Array.from({ length: N }, () => newClient());
    await Promise.all(clients.map((c) => c.connect()));

    const results = await Promise.allSettled(
      clients.map((c) =>
        c.query('select fn_admin_convert_platform_earnings_to_cash($1, $2, $3)', [
          admin,
          QA_CURRENCY,
          6000,
        ]),
      ),
    );
    await Promise.all(clients.map((c) => c.end()));

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    log(
      `${N} truly concurrent conversions competing for the same 6000-credit balance: exactly one succeeds`,
      successes === 1,
      `got ${successes} successes`,
    );

    const earnings = await db.query(
      `select balance from wallets where kind = 'platform_revenue_earnings_cut' and currency = $1 and user_id is null`,
      [QA_CURRENCY],
    );
    log(
      'the earnings-cut wallet never goes negative (row locking prevented a lost-update double-spend)',
      Number(earnings.rows[0].balance) === 0,
      `balance=${earnings.rows[0].balance}`,
    );
  } finally {
    await cleanupQaPlatformWallets(db);
    await deleteTestAdmin(db, admin);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testRegistrationRequiresDualApproval(admin);
    await testDeactivationIsSingleAdmin(admin);
    await testConvertEarningsToCash(admin);
    await testConcurrentConvertCannotDoubleSpendEarnings(admin);
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
