#!/usr/bin/env node
// Admin dashboard Phase C piece 1 — DB-level tests for
// 20260920140000_admin_reports_fraud_schema.sql. Same pattern as
// admin-rbac-functions.test.js: real pg.Client against the real linked dev
// database, fresh random fixtures per run, self-cleaning.
//
// Covers: fn_admin_set_wallet_frozen and fn_admin_set_user_suspended are
// the first-ever admin-triggerable freeze/suspend code paths in this
// codebase, so their permission gate and audit trail matter as much as the
// state change itself; fn_admin_resolve_fraud_signal/
// fn_admin_resolve_user_report each get their real resolution paths
// exercised, including that resolving a report as suspended/banned
// actually flips users.is_suspended (composing fn_admin_set_user_suspended
// under the hood) and that resolving an already-resolved row is rejected,
// not silently re-applied.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-reports` from the repo root.',
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
  await db.query('delete from admin_user_roles where admin_user_id = $1', [id]);
  await db.query('alter table admin_audit_log disable trigger admin_audit_log_no_delete');
  await db.query('delete from admin_audit_log where admin_user_id = $1', [id]);
  await db.query('alter table admin_audit_log enable trigger admin_audit_log_no_delete');
  await db.query('delete from admin_users where id = $1', [id]);
}

async function createTestUser(db) {
  const id = crypto.randomUUID();
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  await db.query(
    `insert into auth.users (id, phone, created_at, aud, role, instance_id)
     values ($1, $2, now(), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`,
    [id, phone],
  );
  return id;
}

async function deleteTestUser(db, id) {
  await db.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await db.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await db.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await db.query('delete from public.fraud_signals where user_id = $1 or related_user_id = $1', [
    id,
  ]);
  await db.query(
    'delete from public.user_reports where reporter_id = $1 or reported_user_id = $1',
    [id],
  );
  await db.query('delete from auth.users where id = $1', [id]);
}

async function testWalletFreeze(db) {
  const authorized = await insertTestAdmin(db, {
    email: `freeze-auth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['compliance_officer'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `freeze-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  const user = await createTestUser(db);

  try {
    const wallet = await db.query(
      `select id from public.wallets where user_id = $1 and kind = 'topup_credit'`,
      [user],
    );
    const walletId = wallet.rows[0].id;

    try {
      await db.query('select fn_admin_set_wallet_frozen($1, $2, true, $3)', [
        unauthorized,
        walletId,
        'test',
      ]);
      log(
        'support_agent cannot freeze a wallet (no resolve_fraud_signal)',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'support_agent cannot freeze a wallet (no resolve_fraud_signal)',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_set_wallet_frozen($1, $2, true, $3)', [
      authorized,
      walletId,
      'suspicious activity',
    ]);
    let row = await db.query('select is_frozen from public.wallets where id = $1', [walletId]);
    log('compliance_officer can freeze a wallet', row.rows[0].is_frozen === true);

    const audit = await db.query(
      `select before_state, after_state from admin_audit_log where admin_user_id = $1 and action = 'freeze_wallet' and target_id = $2`,
      [authorized, walletId],
    );
    log(
      'freezing writes an audit_log row with before/after state',
      audit.rowCount === 1 &&
        audit.rows[0].before_state.is_frozen === false &&
        audit.rows[0].after_state.is_frozen === true,
      JSON.stringify(audit.rows[0]),
    );

    await db.query('select fn_admin_set_wallet_frozen($1, $2, false, $3)', [
      authorized,
      walletId,
      'cleared',
    ]);
    row = await db.query('select is_frozen from public.wallets where id = $1', [walletId]);
    log('the same function unfreezes (reversible, not one-way)', row.rows[0].is_frozen === false);
  } finally {
    await deleteTestUser(db, user);
    await deleteTestAdmin(db, authorized);
    await deleteTestAdmin(db, unauthorized);
  }
}

async function testUserSuspend(db) {
  const authorized = await insertTestAdmin(db, {
    email: `suspend-auth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `suspend-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['content_moderator'],
  });
  const user = await createTestUser(db);

  try {
    try {
      await db.query('select fn_admin_set_user_suspended($1, $2, true, $3)', [
        unauthorized,
        user,
        'test',
      ]);
      log(
        'content_moderator cannot suspend a user (no resolve_user_report)',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'content_moderator cannot suspend a user (no resolve_user_report)',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_set_user_suspended($1, $2, true, $3)', [
      authorized,
      user,
      'reported for spam',
    ]);
    let row = await db.query('select is_suspended from public.users where id = $1', [user]);
    log('support_agent can suspend a user', row.rows[0].is_suspended === true);

    await db.query('select fn_admin_set_user_suspended($1, $2, false, $3)', [
      authorized,
      user,
      'appeal accepted',
    ]);
    row = await db.query('select is_suspended from public.users where id = $1', [user]);
    log('the same function unsuspends (reversible)', row.rows[0].is_suspended === false);
  } finally {
    await deleteTestUser(db, user);
    await deleteTestAdmin(db, authorized);
    await deleteTestAdmin(db, unauthorized);
  }
}

async function testResolveFraudSignal(db) {
  const authorized = await insertTestAdmin(db, {
    email: `fraud-auth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['compliance_officer'],
  });
  const user = await createTestUser(db);

  try {
    const signal = await db.query(
      `insert into public.fraud_signals (user_id, signal_type, severity, metadata) values ($1, 'shared_device_fingerprint', 'low', '{}') returning id`,
      [user],
    );
    const signalId = signal.rows[0].id;

    await db.query('select fn_admin_resolve_fraud_signal($1, $2, $3, $4)', [
      authorized,
      signalId,
      'escalated',
      'looks coordinated',
    ]);
    let row = await db.query(
      'select resolved_at, resolved_by, resolution, severity from public.fraud_signals where id = $1',
      [signalId],
    );
    log(
      'escalating resolves the signal and bumps severity to high',
      row.rows[0].resolved_at !== null &&
        row.rows[0].resolution === 'escalated' &&
        row.rows[0].severity === 'high',
      JSON.stringify(row.rows[0]),
    );

    try {
      await db.query('select fn_admin_resolve_fraud_signal($1, $2, $3, $4)', [
        authorized,
        signalId,
        'dismissed',
        'nvm',
      ]);
      log('an already-resolved signal cannot be resolved again', false, 'expected rejection');
    } catch (e) {
      log(
        'an already-resolved signal cannot be resolved again',
        /signal_not_found_or_already_resolved/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_resolve_fraud_signal($1, $2, $3, $4)', [
        authorized,
        crypto.randomUUID(),
        'not_a_real_value',
        'x',
      ]);
      log('an invalid resolution value is rejected', false, 'expected invalid_resolution');
    } catch (e) {
      log(
        'an invalid resolution value is rejected',
        /invalid_resolution/.test(e.message),
        e.message,
      );
    }
  } finally {
    await deleteTestUser(db, user);
    await deleteTestAdmin(db, authorized);
  }
}

async function testResolveUserReport(db) {
  const authorized = await insertTestAdmin(db, {
    email: `report-auth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  const reporter = await createTestUser(db);
  const reported = await createTestUser(db);

  try {
    const report = await db.query(
      `insert into public.user_reports (reporter_id, reported_user_id, reason) values ($1, $2, 'harassment') returning id`,
      [reporter, reported],
    );
    const reportId = report.rows[0].id;

    await db.query('select fn_admin_resolve_user_report($1, $2, $3, $4)', [
      authorized,
      reportId,
      'suspended',
      'confirmed harassment',
    ]);

    const row = await db.query(
      'select resolved_at, resolution from public.user_reports where id = $1',
      [reportId],
    );
    log(
      'resolving as suspended marks the report resolved',
      row.rows[0].resolved_at !== null && row.rows[0].resolution === 'suspended',
    );

    const user = await db.query('select is_suspended from public.users where id = $1', [reported]);
    log(
      'resolving as suspended actually flips is_suspended on the reported user',
      user.rows[0].is_suspended === true,
    );

    const audit = await db.query(
      `select action from admin_audit_log where admin_user_id = $1 and target_id in ($2, $3) order by created_at`,
      [authorized, reportId, reported],
    );
    log(
      'both the report-resolution and the suspend action are separately audit-logged',
      audit.rows.some((r) => r.action === 'resolve_user_report') &&
        audit.rows.some((r) => r.action === 'suspend_user'),
      JSON.stringify(audit.rows),
    );
  } finally {
    await deleteTestUser(db, reporter);
    await deleteTestUser(db, reported);
    await deleteTestAdmin(db, authorized);
  }
}

async function testExecuteGrantsAreLocked(db) {
  const fns = [
    'fn_admin_set_wallet_frozen(uuid, uuid, boolean, text)',
    'fn_admin_set_user_suspended(uuid, uuid, boolean, text)',
    'fn_admin_resolve_fraud_signal(uuid, uuid, text, text)',
    'fn_admin_resolve_user_report(uuid, uuid, text, text)',
  ];
  for (const fn of fns) {
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
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testWalletFreeze(admin);
    await testUserSuspend(admin);
    await testResolveFraudSignal(admin);
    await testResolveUserReport(admin);
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
