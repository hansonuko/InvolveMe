#!/usr/bin/env node
// Admins list/management page (docs/14-ADMIN-DASHBOARD-SCOPING.md §8), Phase
// G piece 2. Same pattern as every other admin-* suite: real pg.Client
// against the real linked dev database, fresh random fixtures per run,
// self-cleaning.
//
// Covers the two new functions this piece adds:
// fn_admin_set_admin_account_status (dual-approval, both directions —
// §4.4 explicitly names "disabling another admin" as materially risky;
// this migration extends the same treatment to reactivation, see that
// migration's header for why) and fn_admin_set_admin_roles (single-admin,
// matching the doc's materiality list, which names disabling specifically
// and nothing else in this area — self-target still blocked on both).
//
// Deliberately does NOT touch any real admin account created outside this
// test run — every fixture admin is freshly created and torn down here,
// same discipline every other admin-* suite already uses.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-account-management` from the repo root.',
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
  await db.query(
    "delete from admin_audit_log where target_type = 'admin_users' and target_id = $1",
    [id],
  );
  await db.query('alter table admin_audit_log enable trigger admin_audit_log_no_delete');
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
    'fn_admin_set_admin_account_status(uuid, uuid, uuid, boolean)',
    'fn_admin_set_admin_roles(uuid, uuid, uuid[])',
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
}

async function testDualApprovalEnforcementForAccountStatus(db) {
  const requester = await insertTestAdmin(db, {
    email: `aam-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `aam-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `aam-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  const target = await insertTestAdmin(db, {
    email: `aam-target-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  let pendingId = null;

  try {
    const disablePayload = { target_admin_id: target, disable: true };

    try {
      await db.query('select fn_admin_set_admin_account_status($1, $2, $3, $4)', [
        requester,
        crypto.randomUUID(),
        target,
        true,
      ]);
      log(
        'setting account status with a nonexistent pending_action_id is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'setting account status with a nonexistent pending_action_id is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_propose_pending_action($1, $2, $3)', [
        unauthorized,
        'admin_account_status_change',
        JSON.stringify(disablePayload),
      ]);
      log(
        'support_agent (no manage_admin_roles) cannot propose an account-status change',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'support_agent (no manage_admin_roles) cannot propose an account-status change',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requester,
      'admin_account_status_change',
      JSON.stringify(disablePayload),
    ]);
    pendingId = proposeRes.rows[0].id;

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [requester, pendingId]);
      log(
        'the requester cannot approve their own account-status proposal',
        false,
        'expected cannot_approve_own_action',
      );
    } catch (e) {
      log(
        'the requester cannot approve their own account-status proposal',
        /cannot_approve_own_action/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);

    try {
      await db.query('select fn_admin_set_admin_account_status($1, $2, $3, $4)', [
        requester,
        pendingId,
        target,
        false, // does not match the approved payload's disable=true
      ]);
      log(
        'applying a different disable value than what was approved is rejected',
        false,
        'expected pending_action_payload_mismatch',
      );
    } catch (e) {
      log(
        'applying a different disable value than what was approved is rejected',
        /pending_action_payload_mismatch/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_set_admin_account_status($1, $2, $3, $4)', [
      requester,
      pendingId,
      target,
      true,
    ]);
    const row = await db.query('select disabled_at from admin_users where id = $1', [target]);
    log(
      'a matching approved disable applies — disabled_at is set',
      row.rows[0].disabled_at !== null,
    );

    const audit = await db.query(
      `select 1 from admin_audit_log where admin_user_id = $1 and action = 'admin_account_disabled' and target_id = $2`,
      [requester, target],
    );
    log(
      'the disable writes an admin_audit_log row attributed to the requester',
      audit.rowCount === 1,
    );

    // Reactivation — same dual-approval path, opposite direction.
    const reactivatePayload = { target_admin_id: target, disable: false };
    const pendingId2 = await proposeAndApprove(db, {
      requester,
      approver,
      actionType: 'admin_account_status_change',
      payload: reactivatePayload,
    });
    await db.query('select fn_admin_set_admin_account_status($1, $2, $3, $4)', [
      requester,
      pendingId2,
      target,
      false,
    ]);
    const row2 = await db.query('select disabled_at from admin_users where id = $1', [target]);
    log(
      'a matching approved reactivation applies — disabled_at is cleared',
      row2.rows[0].disabled_at === null,
    );
    await db.query('delete from admin_pending_actions where id = $1', [pendingId2]);
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
    await deleteTestAdmin(db, unauthorized);
    await deleteTestAdmin(db, target);
  }
}

async function testSelfTargetAccountStatusIsAllowed(db) {
  // Deliberate: unlike role changes, an admin CAN propose disabling their
  // own account (e.g. suspected compromise) — the safety property comes
  // entirely from requiring a different admin's approval, same as every
  // other dual-approved action, not from a target != self check.
  const requester = await insertTestAdmin(db, {
    email: `aam-self-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `aam-self-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  let pendingId = null;

  try {
    pendingId = await proposeAndApprove(db, {
      requester,
      approver,
      actionType: 'admin_account_status_change',
      payload: { target_admin_id: requester, disable: true },
    });
    await db.query('select fn_admin_set_admin_account_status($1, $2, $3, $4)', [
      requester,
      pendingId,
      requester,
      true,
    ]);
    const row = await db.query('select disabled_at from admin_users where id = $1', [requester]);
    log(
      'an admin can propose disabling their own account, applied by a different approver',
      row.rows[0].disabled_at !== null,
    );
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testAdminRolesReplacement(db) {
  const actor = await insertTestAdmin(db, {
    email: `aam-roles-actor-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `aam-roles-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  const target = await insertTestAdmin(db, {
    email: `aam-roles-target-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });

  try {
    try {
      await db.query('select fn_admin_set_admin_roles($1, $1, $2)', [actor, []]);
      log('an admin cannot change their own roles', false, 'expected cannot_change_own_roles');
    } catch (e) {
      log(
        'an admin cannot change their own roles',
        /cannot_change_own_roles/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_set_admin_roles($1, $2, $3)', [unauthorized, target, []]);
      log(
        "support_agent (no manage_admin_roles) cannot change another admin's roles",
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        "support_agent (no manage_admin_roles) cannot change another admin's roles",
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_set_admin_roles($1, $2, $3)', [
        actor,
        target,
        [crypto.randomUUID()],
      ]);
      log('a nonexistent role_id is rejected', false, 'expected invalid_role_id');
    } catch (e) {
      log('a nonexistent role_id is rejected', /invalid_role_id/.test(e.message), e.message);
    }

    const financeRoleId = (
      await db.query(`select id from admin_roles where name = 'finance_admin'`)
    ).rows[0].id;
    const complianceRoleId = (
      await db.query(`select id from admin_roles where name = 'compliance_officer'`)
    ).rows[0].id;

    await db.query('select fn_admin_set_admin_roles($1, $2, $3)', [
      actor,
      target,
      [financeRoleId, complianceRoleId],
    ]);
    const roles1 = await db.query(
      'select role_id from admin_user_roles where admin_user_id = $1 order by role_id',
      [target],
    );
    log(
      "setting roles replaces the target's role set exactly",
      roles1.rowCount === 2 &&
        roles1.rows.some((r) => r.role_id === financeRoleId) &&
        roles1.rows.some((r) => r.role_id === complianceRoleId),
    );

    // Replace down to a single role — confirms it's a replace, not a merge.
    await db.query('select fn_admin_set_admin_roles($1, $2, $3)', [actor, target, [financeRoleId]]);
    const roles2 = await db.query('select role_id from admin_user_roles where admin_user_id = $1', [
      target,
    ]);
    log(
      'a second call fully replaces (not merges) the role set',
      roles2.rowCount === 1 && roles2.rows[0].role_id === financeRoleId,
    );

    const audit = await db.query(
      `select 1 from admin_audit_log where admin_user_id = $1 and action = 'admin_roles_changed' and target_id = $2`,
      [actor, target],
    );
    log(
      'each role change writes an admin_audit_log row attributed to the actor',
      audit.rowCount >= 1,
    );
  } finally {
    await deleteTestAdmin(db, actor);
    await deleteTestAdmin(db, unauthorized);
    await deleteTestAdmin(db, target);
  }
}

async function testConcurrentRoleReplacementsSerialize(db) {
  const actor1 = await insertTestAdmin(db, {
    email: `aam-conc-actor1-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const actor2 = await insertTestAdmin(db, {
    email: `aam-conc-actor2-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['super_admin'],
  });
  const target = await insertTestAdmin(db, {
    email: `aam-conc-target-${crypto.randomUUID()}@test.invalid`,
    roleNames: [],
  });

  try {
    const financeRoleId = (
      await db.query(`select id from admin_roles where name = 'finance_admin'`)
    ).rows[0].id;
    const complianceRoleId = (
      await db.query(`select id from admin_roles where name = 'compliance_officer'`)
    ).rows[0].id;

    const dbA = newClient();
    const dbB = newClient();
    await dbA.connect();
    await dbB.connect();
    try {
      // Two concurrent full-replace calls on the SAME target with
      // different role sets — the row lock in fn_admin_set_admin_roles
      // should serialize these, so the end state is exactly one call's
      // role set, never a mix of both (e.g. 3 rows from an interleaved
      // delete+insert).
      await Promise.all([
        dbA.query('select fn_admin_set_admin_roles($1, $2, $3)', [actor1, target, [financeRoleId]]),
        dbB.query('select fn_admin_set_admin_roles($1, $2, $3)', [
          actor2,
          target,
          [complianceRoleId],
        ]),
      ]);
    } finally {
      await dbA.end();
      await dbB.end();
    }

    const finalRoles = await db.query(
      'select role_id from admin_user_roles where admin_user_id = $1',
      [target],
    );
    log(
      "two concurrent role-set calls on the same admin serialize — final state is exactly one call's set, never a mix",
      finalRoles.rowCount === 1 &&
        (finalRoles.rows[0].role_id === financeRoleId ||
          finalRoles.rows[0].role_id === complianceRoleId),
      `got ${finalRoles.rowCount} rows`,
    );
  } finally {
    await deleteTestAdmin(db, actor1);
    await deleteTestAdmin(db, actor2);
    await deleteTestAdmin(db, target);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testDualApprovalEnforcementForAccountStatus(admin);
    await testSelfTargetAccountStatusIsAllowed(admin);
    await testAdminRolesReplacement(admin);
    await testConcurrentRoleReplacementsSerialize(admin);
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
