#!/usr/bin/env node
// Admin dashboard Phase A — DB-level tests for the RBAC schema/functions in
// 20260920110000_admin_rbac_schema.sql / 20260920111500_admin_rbac_functions.sql.
// Same pattern as wallet-functions.test.js: real pg.Client against the real
// linked dev database, fresh random UUIDs per run, self-cleaning. These
// functions don't touch a balance, so this isn't a CLAUDE.md
// ledger-conservation suite — it's the equivalent discipline applied to the
// RBAC/audit invariants docs/14 actually cares about: grants are locked
// (rule #11), the audit log is truly append-only (not just by convention),
// permission checks are enforced not assumed, and the two row-locked
// counters (failed-login lockout, recovery-code consumption) can't lose an
// update under real concurrency — the same class of bug CLAUDE.md's
// concurrency-test rule exists to catch, applied to a security counter
// instead of a wallet balance.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is not set. Run via `npm run test:admin` from the repo root.');
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
  return `argon2id$fake$${label}$${crypto.randomBytes(8).toString('hex')}`;
}

async function insertTestAdmin(db, { email, roleNames = [], disabled = false }) {
  const id = crypto.randomUUID();
  await db.query(
    `insert into admin_users (id, email, display_name, password_hash, disabled_at)
     values ($1, $2, $3, $4, $5)`,
    [id, email, 'Test Admin', fakeHash('pw'), disabled ? new Date() : null],
  );
  for (const roleName of roleNames) {
    await db.query(
      `insert into admin_user_roles (admin_user_id, role_id)
       select $1, id from admin_roles where name = $2`,
      [id, roleName],
    );
  }
  return id;
}

async function deleteTestAdmin(db, id) {
  await db.query('delete from admin_user_roles where admin_user_id = $1', [id]);
  // Same pattern wallet-functions.test.js already established for
  // ledger_entries: the append-only trigger is real production behavior
  // (an admin with audit history can never be hard-deleted, which is
  // exactly the guarantee admin_audit_log exists to provide), so test
  // teardown temporarily disables it rather than weakening the trigger
  // itself. admin_users.id is FK-referenced by admin_audit_log with no ON
  // DELETE clause (RESTRICT) — deliberately, so the same disable/delete/
  // re-enable is required here before a test admin_users row can go away.
  await db.query('begin');
  await db.query('alter table admin_audit_log disable trigger admin_audit_log_no_delete');
  await db.query('delete from admin_audit_log where admin_user_id = $1', [id]);
  await db.query('alter table admin_audit_log enable trigger admin_audit_log_no_delete');
  await db.query('commit');
  await db.query('delete from admin_users where id = $1', [id]);
}

async function testBootstrapGuardRejectsWhenNotEmpty(db) {
  const dummyId = await insertTestAdmin(db, { email: `guard-${crypto.randomUUID()}@test.invalid` });
  try {
    await db.query('select fn_admin_bootstrap_first_user($1, $2, $3)', [
      `bootstrap-${crypto.randomUUID()}@test.invalid`,
      'Should Not Be Created',
      fakeHash('pw'),
    ]);
    log(
      'bootstrap rejects when admin_users is non-empty',
      false,
      'expected admin_users_not_empty exception',
    );
  } catch (e) {
    log(
      'bootstrap rejects when admin_users is non-empty',
      /admin_users_not_empty/.test(e.message),
      e.message,
    );
  } finally {
    await deleteTestAdmin(db, dummyId);
  }
}

async function testBootstrapSucceedsWhenEmpty(db) {
  const countRes = await db.query('select count(*)::int as n from admin_users');
  if (countRes.rows[0].n !== 0) {
    log(
      'bootstrap succeeds when admin_users is empty',
      true,
      "SKIPPED — table already has real admin rows, not this test's to touch",
    );
    return;
  }

  const email = `bootstrap-${crypto.randomUUID()}@test.invalid`;
  const res = await db.query('select fn_admin_bootstrap_first_user($1, $2, $3) as id', [
    email,
    'Bootstrap Admin',
    fakeHash('pw'),
  ]);
  const newId = res.rows[0].id;

  try {
    const roleRes = await db.query(
      `select r.name from admin_user_roles ur join admin_roles r on r.id = ur.role_id where ur.admin_user_id = $1`,
      [newId],
    );
    log(
      'bootstrapped admin gets super_admin role',
      roleRes.rows.map((r) => r.name).includes('super_admin'),
    );

    const auditRes = await db.query(
      `select 1 from admin_audit_log where admin_user_id = $1 and action = 'bootstrap_first_admin'`,
      [newId],
    );
    log('bootstrap writes an audit_log row', auditRes.rowCount === 1);
  } finally {
    await deleteTestAdmin(db, newId);
  }
}

async function testCreateUserRequiresPermission(db) {
  const superAdminId = await insertTestAdmin(db, {
    email: `super-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const unprivilegedId = await insertTestAdmin(db, {
    email: `unpriv-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  let createdId = null;

  try {
    try {
      await db.query('select fn_admin_create_user($1, $2, $3, $4, $5)', [
        unprivilegedId,
        `blocked-${crypto.randomUUID()}@test.invalid`,
        'Should Be Blocked',
        fakeHash('pw'),
        [],
      ]);
      log(
        'support_agent cannot create an admin (no manage_admin_roles)',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'support_agent cannot create an admin (no manage_admin_roles)',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    const roleRes = await db.query("select id from admin_roles where name = 'support_agent'");
    const createRes = await db.query('select fn_admin_create_user($1, $2, $3, $4, $5) as id', [
      superAdminId,
      `created-${crypto.randomUUID()}@test.invalid`,
      'Created By Super Admin',
      fakeHash('pw'),
      [roleRes.rows[0].id],
    ]);
    createdId = createRes.rows[0].id;
    log('super_admin can create a new admin', !!createdId);

    const auditRes = await db.query(
      `select after_state from admin_audit_log where admin_user_id = $1 and action = 'create_admin_user' and target_id = $2`,
      [superAdminId, createdId],
    );
    log('create_user writes an audit_log row attributed to the creator', auditRes.rowCount === 1);

    try {
      await db.query('select fn_admin_create_user($1, $2, $3, $4, $5)', [
        superAdminId,
        `bad-role-${crypto.randomUUID()}@test.invalid`,
        'Bad Role',
        fakeHash('pw'),
        [crypto.randomUUID()],
      ]);
      log('create_user rejects a role_id that does not exist', false, 'expected invalid_role_id');
    } catch (e) {
      log(
        'create_user rejects a role_id that does not exist',
        /invalid_role_id/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (createdId) await deleteTestAdmin(db, createdId);
    await deleteTestAdmin(db, unprivilegedId);
    await deleteTestAdmin(db, superAdminId);
  }
}

async function testCheckPermission(db) {
  const financeId = await insertTestAdmin(db, {
    email: `finance-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const disabledId = await insertTestAdmin(db, {
    email: `disabled-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
    disabled: true,
  });

  try {
    const yes = await db.query('select fn_admin_check_permission($1, $2) as ok', [
      financeId,
      'edit_pricing_config',
    ]);
    log('finance_admin has edit_pricing_config', yes.rows[0].ok === true);

    const no = await db.query('select fn_admin_check_permission($1, $2) as ok', [
      financeId,
      'manage_admin_roles',
    ]);
    log('finance_admin lacks manage_admin_roles', no.rows[0].ok === false);

    const disabledCheck = await db.query('select fn_admin_check_permission($1, $2) as ok', [
      disabledId,
      'manage_admin_roles',
    ]);
    log(
      'a disabled admin fails every permission check even with super_admin role',
      disabledCheck.rows[0].ok === false,
    );
  } finally {
    await deleteTestAdmin(db, financeId);
    await deleteTestAdmin(db, disabledId);
  }
}

async function testLoginAttemptTrackingAndLockout(db) {
  const id = await insertTestAdmin(db, { email: `login-${crypto.randomUUID()}@test.invalid` });

  try {
    for (let i = 0; i < 9; i++) {
      await db.query('select fn_admin_record_login_attempt($1, false, $2)', [id, '127.0.0.1']);
    }
    let row = await db.query(
      'select failed_login_count, locked_until from admin_users where id = $1',
      [id],
    );
    log(
      '9 sequential failures: not yet locked',
      row.rows[0].failed_login_count === 9 && row.rows[0].locked_until === null,
    );

    await db.query('select fn_admin_record_login_attempt($1, false, $2)', [id, '127.0.0.1']);
    row = await db.query('select failed_login_count, locked_until from admin_users where id = $1', [
      id,
    ]);
    log(
      '10th failure locks the account for 15 minutes',
      row.rows[0].failed_login_count === 10 && row.rows[0].locked_until !== null,
    );

    const auditRes = await db.query(
      `select count(*)::int as n from admin_audit_log where admin_user_id = $1 and action = 'login_failure'`,
      [id],
    );
    log('every failed attempt writes an audit_log row', auditRes.rows[0].n === 10);

    await db.query('select fn_admin_record_login_attempt($1, true, $2)', [id, '127.0.0.1']);
    row = await db.query(
      'select failed_login_count, locked_until, last_login_at from admin_users where id = $1',
      [id],
    );
    log(
      'a success resets failed_login_count and clears the lock',
      row.rows[0].failed_login_count === 0 &&
        row.rows[0].locked_until === null &&
        row.rows[0].last_login_at !== null,
    );
  } finally {
    await deleteTestAdmin(db, id);
  }
}

async function testConcurrentFailedLoginsCannotUndercount(db) {
  const id = await insertTestAdmin(db, {
    email: `concurrent-login-${crypto.randomUUID()}@test.invalid`,
  });
  const N = 8;

  try {
    const clients = Array.from({ length: N }, () => newClient());
    await Promise.all(clients.map((c) => c.connect()));

    await Promise.all(
      clients.map((c) =>
        c.query('select fn_admin_record_login_attempt($1, false, $2)', [id, '127.0.0.1']),
      ),
    );

    await Promise.all(clients.map((c) => c.end()));

    const row = await db.query('select failed_login_count from admin_users where id = $1', [id]);
    log(
      `${N} truly concurrent failed logins all counted (row lock prevents lost updates)`,
      row.rows[0].failed_login_count === N,
      `got ${row.rows[0].failed_login_count}, expected ${N}`,
    );
  } finally {
    await deleteTestAdmin(db, id);
  }
}

async function testMfaEnrollAndReset(db) {
  const targetId = await insertTestAdmin(db, {
    email: `mfa-target-${crypto.randomUUID()}@test.invalid`,
  });
  const resetterUnauthorized = await insertTestAdmin(db, {
    email: `mfa-unpriv-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  const resetterAuthorized = await insertTestAdmin(db, {
    email: `mfa-super-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });

  try {
    await db.query('select fn_admin_enroll_mfa($1, $2, $3)', [
      targetId,
      'ciphertext-abc',
      [fakeHash('rc1'), fakeHash('rc2')],
    ]);
    let row = await db.query('select totp_enrolled_at from admin_users where id = $1', [targetId]);
    log('first MFA enrollment succeeds', row.rows[0].totp_enrolled_at !== null);

    try {
      await db.query('select fn_admin_enroll_mfa($1, $2, $3)', [targetId, 'ciphertext-def', []]);
      log(
        're-enrolling an already-enrolled admin is rejected',
        false,
        'expected already_enrolled_or_not_found',
      );
    } catch (e) {
      log(
        're-enrolling an already-enrolled admin is rejected',
        /already_enrolled_or_not_found/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_reset_mfa($1, $1)', [targetId]);
      log('an admin cannot reset their own MFA', false, 'expected cannot_reset_own_mfa');
    } catch (e) {
      log('an admin cannot reset their own MFA', /cannot_reset_own_mfa/.test(e.message), e.message);
    }

    try {
      await db.query('select fn_admin_reset_mfa($1, $2)', [resetterUnauthorized, targetId]);
      log(
        "an admin without manage_admin_roles cannot reset another admin's MFA",
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        "an admin without manage_admin_roles cannot reset another admin's MFA",
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_reset_mfa($1, $2)', [resetterAuthorized, targetId]);
    row = await db.query(
      'select totp_enrolled_at, totp_secret_encrypted, recovery_code_hashes from admin_users where id = $1',
      [targetId],
    );
    log(
      'an authorized different admin can reset MFA, clearing secret + recovery codes',
      row.rows[0].totp_enrolled_at === null &&
        row.rows[0].totp_secret_encrypted === null &&
        row.rows[0].recovery_code_hashes.length === 0,
    );

    const auditRes = await db.query(
      `select 1 from admin_audit_log where admin_user_id = $1 and action = 'mfa_reset' and target_id = $2`,
      [resetterAuthorized, targetId],
    );
    log(
      'MFA reset writes an audit_log row attributed to the resetter, not the target',
      auditRes.rowCount === 1,
    );
  } finally {
    await deleteTestAdmin(db, targetId);
    await deleteTestAdmin(db, resetterUnauthorized);
    await deleteTestAdmin(db, resetterAuthorized);
  }
}

async function testRecoveryCodeConsumption(db) {
  const codeHash = fakeHash('recovery');
  const id = await insertTestAdmin(db, { email: `recovery-${crypto.randomUUID()}@test.invalid` });
  await db.query('select fn_admin_enroll_mfa($1, $2, $3)', [
    id,
    'ciphertext',
    [codeHash, fakeHash('other')],
  ]);

  try {
    const firstUse = await db.query('select fn_admin_consume_recovery_code($1, $2) as ok', [
      id,
      codeHash,
    ]);
    log('a valid recovery code is accepted once', firstUse.rows[0].ok === true);

    const reuse = await db.query('select fn_admin_consume_recovery_code($1, $2) as ok', [
      id,
      codeHash,
    ]);
    log('the same recovery code cannot be used twice', reuse.rows[0].ok === false);

    const bogus = await db.query('select fn_admin_consume_recovery_code($1, $2) as ok', [
      id,
      fakeHash('never-issued'),
    ]);
    log('an unissued recovery code is rejected', bogus.rows[0].ok === false);
  } finally {
    await deleteTestAdmin(db, id);
  }
}

async function testConcurrentRecoveryCodeConsumptionIsSingleUse(db) {
  const codeHash = fakeHash('concurrent-recovery');
  const id = await insertTestAdmin(db, {
    email: `concurrent-recovery-${crypto.randomUUID()}@test.invalid`,
  });
  await db.query('select fn_admin_enroll_mfa($1, $2, $3)', [id, 'ciphertext', [codeHash]]);

  try {
    const N = 6;
    const clients = Array.from({ length: N }, () => newClient());
    await Promise.all(clients.map((c) => c.connect()));

    const results = await Promise.all(
      clients.map((c) =>
        c.query('select fn_admin_consume_recovery_code($1, $2) as ok', [id, codeHash]),
      ),
    );

    await Promise.all(clients.map((c) => c.end()));

    const successes = results.filter((r) => r.rows[0].ok === true).length;
    log(
      `${N} concurrent attempts to consume the same recovery code: exactly one wins`,
      successes === 1,
      `got ${successes} successes`,
    );
  } finally {
    await deleteTestAdmin(db, id);
  }
}

async function testAuditLogIsTrulyAppendOnly(db) {
  const id = await insertTestAdmin(db, { email: `audit-${crypto.randomUUID()}@test.invalid` });
  await db.query('select fn_admin_log_action($1, $2, $3, $4, $5, $6, $7)', [
    id,
    'test_action',
    'admin_users',
    id,
    null,
    null,
    '127.0.0.1',
  ]);

  try {
    try {
      await db.query("update admin_audit_log set action = 'tampered' where admin_user_id = $1", [
        id,
      ]);
      log(
        'admin_audit_log rejects UPDATE, including for a direct DB connection',
        false,
        'expected append-only exception',
      );
    } catch (e) {
      log(
        'admin_audit_log rejects UPDATE, including for a direct DB connection',
        /append-only/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('delete from admin_audit_log where admin_user_id = $1', [id]);
      log(
        'admin_audit_log rejects DELETE, including for a direct DB connection',
        false,
        'expected append-only exception',
      );
    } catch (e) {
      log(
        'admin_audit_log rejects DELETE, including for a direct DB connection',
        /append-only/.test(e.message),
        e.message,
      );
    }
  } finally {
    await deleteTestAdmin(db, id);
  }
}

async function testExecuteGrantsAreLocked(db) {
  const functions = [
    'fn_admin_bootstrap_first_user(text, text, text)',
    'fn_admin_get_login_material(text)',
    'fn_admin_record_login_attempt(uuid, boolean, text)',
    'fn_admin_check_permission(uuid, text)',
    'fn_admin_create_user(uuid, text, text, text, uuid[])',
    'fn_admin_enroll_mfa(uuid, text, text[])',
    'fn_admin_reset_mfa(uuid, uuid)',
    'fn_admin_consume_recovery_code(uuid, text)',
    'fn_admin_log_action(uuid, text, text, text, jsonb, jsonb, text)',
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

  const insertRes = await db.query('select has_table_privilege($1, $2, $3) as ok', [
    'service_role',
    'public.admin_audit_log',
    'insert',
  ]);
  log(
    'service_role cannot INSERT into admin_audit_log directly (only via fn_admin_log_action)',
    insertRes.rows[0].ok === false,
  );
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testBootstrapGuardRejectsWhenNotEmpty(admin);
    await testBootstrapSucceedsWhenEmpty(admin);
    await testCreateUserRequiresPermission(admin);
    await testCheckPermission(admin);
    await testLoginAttemptTrackingAndLockout(admin);
    await testConcurrentFailedLoginsCannotUndercount(admin);
    await testMfaEnrollAndReset(admin);
    await testRecoveryCodeConsumption(admin);
    await testConcurrentRecoveryCodeConsumptionIsSingleUse(admin);
    await testAuditLogIsTrulyAppendOnly(admin);
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
