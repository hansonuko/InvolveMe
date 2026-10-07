#!/usr/bin/env node
// Admin dashboard Phase E piece 1 — DB-level tests for the dual-approval
// engine in 20260923090000_admin_dual_approval_pending_actions.sql. Same
// pattern as admin-rbac-functions.test.js: real pg.Client against the real
// linked dev database, fresh random UUIDs per run, self-cleaning.
//
// What this suite actually cares about, per the pre-build review findings
// that shaped the migration: grants are locked (rule #11), a proposer
// can never approve their own proposal regardless of what permissions
// they hold, an approver needs BOTH the action's own underlying
// permission and approve_pending_action (not just a generic rubber
// stamp), expiry is enforced lazily and can't be bypassed, and
// fn_admin_consume_approved_pending_action can only ever redeem a given
// approval exactly once — including under real concurrent calls, the
// same "claim it once" class of bug CLAUDE.md's concurrency-test rule
// exists to catch for wallet balances, applied here to an approval token
// instead.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-dual-approval` from the repo root.',
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

// Bespoke, temporary role with exactly one of the two permissions
// fn_admin_approve_pending_action requires — none of the six seeded roles
// isolate these two permissions from each other (finance_admin/super_admin
// hold both together), so proving the AND is real requires constructing
// the split by hand.
async function insertIsolatedPermissionRole(db, permissionName) {
  const roleName = `test-role-${crypto.randomUUID()}`;
  const roleRes = await db.query(
    `insert into admin_roles (name, description) values ($1, 'temporary test-only role') returning id`,
    [roleName],
  );
  const roleId = roleRes.rows[0].id;
  await db.query(
    `insert into admin_role_permissions (role_id, permission_id)
     select $1, id from admin_permissions where name = $2`,
    [roleId, permissionName],
  );
  return { roleId, roleName };
}

async function deleteRole(db, roleId) {
  await db.query('delete from admin_role_permissions where role_id = $1', [roleId]);
  await db.query('delete from admin_roles where id = $1', [roleId]);
}

async function deletePendingAction(db, id) {
  await db.query('delete from admin_pending_actions where id = $1', [id]);
}

async function testExecuteGrantsAreLocked(db) {
  const functions = [
    'fn_admin_pending_action_required_permission(text)',
    'fn_admin_propose_pending_action(uuid, text, jsonb)',
    'fn_admin_approve_pending_action(uuid, uuid)',
    'fn_admin_reject_pending_action(uuid, uuid, text)',
    'fn_admin_consume_approved_pending_action(uuid, text)',
    'fn_admin_expire_stale_pending_actions()',
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
    'public.admin_pending_actions',
    'insert',
  ]);
  log(
    'service_role cannot INSERT into admin_pending_actions directly (only via fn_admin_propose_pending_action)',
    writeRes.rows[0].ok === false,
  );
}

async function testProposeRequiresMatchingPermission(db) {
  const financeId = await insertTestAdmin(db, {
    email: `propose-finance-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const unprivilegedId = await insertTestAdmin(db, {
    email: `propose-unpriv-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  let pendingId = null;

  try {
    try {
      await db.query('select fn_admin_propose_pending_action($1, $2, $3)', [
        unprivilegedId,
        'pricing_config_update',
        JSON.stringify({ key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 500 }),
      ]);
      log(
        'support_agent cannot propose a pricing_config_update (no edit_pricing_config)',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'support_agent cannot propose a pricing_config_update (no edit_pricing_config)',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      financeId,
      'pricing_config_update',
      JSON.stringify({ key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 500 }),
    ]);
    pendingId = res.rows[0].id;
    log('finance_admin can propose a pricing_config_update', !!pendingId);

    const row = await db.query(
      'select status, requested_by, action_type from admin_pending_actions where id = $1',
      [pendingId],
    );
    log(
      'the proposed row starts pending, attributed to the real requester',
      row.rows[0].status === 'pending' &&
        row.rows[0].requested_by === financeId &&
        row.rows[0].action_type === 'pricing_config_update',
    );

    const auditRes = await db.query(
      `select 1 from admin_audit_log where admin_user_id = $1 and action = 'propose_pending_action' and target_id = $2`,
      [financeId, pendingId],
    );
    log('propose writes an audit_log row attributed to the requester', auditRes.rowCount === 1);
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, financeId);
    await deleteTestAdmin(db, unprivilegedId);
  }
}

async function testProposeRejectsUnknownActionType(db) {
  const financeId = await insertTestAdmin(db, {
    email: `propose-unknown-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });

  try {
    try {
      await db.query('select fn_admin_propose_pending_action($1, $2, $3)', [
        financeId,
        'not_a_real_action_type',
        JSON.stringify({}),
      ]);
      log('proposing an unknown action_type is rejected', false, 'expected unknown_action_type');
    } catch (e) {
      log(
        'proposing an unknown action_type is rejected',
        /unknown_action_type/.test(e.message),
        e.message,
      );
    }
  } finally {
    await deleteTestAdmin(db, financeId);
  }
}

async function testApproveRejectsSelfApproval(db) {
  const financeId = await insertTestAdmin(db, {
    email: `self-approve-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;

  try {
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      financeId,
      'pricing_config_update',
      JSON.stringify({ key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 400 }),
    ]);
    pendingId = res.rows[0].id;

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [financeId, pendingId]);
      log(
        'a requester cannot approve their own proposal, even holding every relevant permission',
        false,
        'expected cannot_approve_own_action',
      );
    } catch (e) {
      log(
        'a requester cannot approve their own proposal, even holding every relevant permission',
        /cannot_approve_own_action/.test(e.message),
        e.message,
      );
    }

    const row = await db.query('select status from admin_pending_actions where id = $1', [
      pendingId,
    ]);
    log(
      'the row is still pending after the blocked self-approval attempt',
      row.rows[0].status === 'pending',
    );
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, financeId);
  }
}

async function testApproveRequiresBothMatchingAndApprovePermission(db) {
  const requesterId = await insertTestAdmin(db, {
    email: `approve-requester-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approveOnly = await insertIsolatedPermissionRole(db, 'approve_pending_action');
  const editOnly = await insertIsolatedPermissionRole(db, 'edit_pricing_config');
  const approverWithoutEdit = await insertTestAdmin(db, {
    email: `approve-only-${crypto.randomUUID()}@test.invalid`,
    roleNames: [approveOnly.roleName],
  });
  const approverWithoutApprove = await insertTestAdmin(db, {
    email: `edit-only-${crypto.randomUUID()}@test.invalid`,
    roleNames: [editOnly.roleName],
  });
  let pendingId = null;

  try {
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requesterId,
      'pricing_config_update',
      JSON.stringify({ key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 300 }),
    ]);
    pendingId = res.rows[0].id;

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [
        approverWithoutEdit,
        pendingId,
      ]);
      log(
        'approve_pending_action alone (no matching edit_pricing_config) is not enough to approve',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'approve_pending_action alone (no matching edit_pricing_config) is not enough to approve',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [
        approverWithoutApprove,
        pendingId,
      ]);
      log(
        'edit_pricing_config alone (no approve_pending_action) is not enough to approve',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'edit_pricing_config alone (no approve_pending_action) is not enough to approve',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    const row = await db.query('select status from admin_pending_actions where id = $1', [
      pendingId,
    ]);
    log(
      'the row is still pending after both incomplete-permission attempts',
      row.rows[0].status === 'pending',
    );
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, approverWithoutEdit);
    await deleteTestAdmin(db, approverWithoutApprove);
    await deleteRole(db, approveOnly.roleId);
    await deleteRole(db, editOnly.roleId);
    await deleteTestAdmin(db, requesterId);
  }
}

async function testApproveSucceedsAndIsFinal(db) {
  const requesterId = await insertTestAdmin(db, {
    email: `approve-req2-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approverId = await insertTestAdmin(db, {
    email: `approve-appr2-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;

  try {
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requesterId,
      'manual_ledger_adjustment',
      JSON.stringify({ wallet_id: crypto.randomUUID(), amount: 100, note: 'test adjustment' }),
    ]);
    pendingId = res.rows[0].id;

    await db.query('select fn_admin_approve_pending_action($1, $2)', [approverId, pendingId]);
    const row = await db.query(
      'select status, approved_by, approved_at from admin_pending_actions where id = $1',
      [pendingId],
    );
    log(
      'a different admin with both matching permissions can approve',
      row.rows[0].status === 'approved' &&
        row.rows[0].approved_by === approverId &&
        row.rows[0].approved_at !== null,
    );

    const auditRes = await db.query(
      `select 1 from admin_audit_log where admin_user_id = $1 and action = 'approve_pending_action' and target_id = $2`,
      [approverId, pendingId],
    );
    log('approve writes an audit_log row attributed to the approver', auditRes.rowCount === 1);

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [approverId, pendingId]);
      log(
        'an already-approved action cannot be approved again',
        false,
        'expected pending_action_not_pending',
      );
    } catch (e) {
      log(
        'an already-approved action cannot be approved again',
        /pending_action_not_pending/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, requesterId);
    await deleteTestAdmin(db, approverId);
  }
}

async function testRejectByRequesterAndByUnauthorizedThirdParty(db) {
  const requesterId = await insertTestAdmin(db, {
    email: `reject-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const unrelatedId = await insertTestAdmin(db, {
    email: `reject-unrelated-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  let pendingId = null;

  try {
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requesterId,
      'pricing_config_update',
      JSON.stringify({ key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 200 }),
    ]);
    pendingId = res.rows[0].id;

    try {
      await db.query('select fn_admin_reject_pending_action($1, $2, $3)', [
        unrelatedId,
        pendingId,
        'not my call',
      ]);
      log(
        "an unrelated admin without matching permissions cannot reject someone else's proposal",
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        "an unrelated admin without matching permissions cannot reject someone else's proposal",
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_reject_pending_action($1, $2, $3)', [
      requesterId,
      pendingId,
      'changed my mind',
    ]);
    const row = await db.query(
      'select status, rejected_by, rejection_reason from admin_pending_actions where id = $1',
      [pendingId],
    );
    log(
      'the original requester can cancel/reject their own proposal without approve_pending_action',
      row.rows[0].status === 'rejected' &&
        row.rows[0].rejected_by === requesterId &&
        row.rows[0].rejection_reason === 'changed my mind',
    );
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, requesterId);
    await deleteTestAdmin(db, unrelatedId);
  }
}

async function testExpiryIsEnforcedLazily(db) {
  const requesterId = await insertTestAdmin(db, {
    email: `expiry-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approverId = await insertTestAdmin(db, {
    email: `expiry-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;

  try {
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requesterId,
      'pricing_config_update',
      JSON.stringify({ key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 100 }),
    ]);
    pendingId = res.rows[0].id;
    await db.query(
      "update admin_pending_actions set requested_at = now() - interval '73 hours' where id = $1",
      [pendingId],
    );

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [approverId, pendingId]);
      log(
        'approving a stale (>72h) pending action is rejected',
        false,
        'expected pending_action_expired',
      );
    } catch (e) {
      log(
        'approving a stale (>72h) pending action is rejected',
        /pending_action_expired/.test(e.message),
        e.message,
      );
    }

    const row = await db.query('select status from admin_pending_actions where id = $1', [
      pendingId,
    ]);
    log(
      'the blocked attempt does not itself mutate the row (RAISE unwinds the whole call) — status is still pending',
      row.rows[0].status === 'pending',
    );
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, requesterId);
    await deleteTestAdmin(db, approverId);
  }
}

async function testConsumeApprovedPendingActionIsSingleUse(db) {
  const requesterId = await insertTestAdmin(db, {
    email: `consume-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approverId = await insertTestAdmin(db, {
    email: `consume-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;

  try {
    const payload = { key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 250 };
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requesterId,
      'pricing_config_update',
      JSON.stringify(payload),
    ]);
    pendingId = res.rows[0].id;
    await db.query('select fn_admin_approve_pending_action($1, $2)', [approverId, pendingId]);

    try {
      await db.query('select fn_admin_consume_approved_pending_action($1, $2)', [
        pendingId,
        'manual_ledger_adjustment',
      ]);
      log(
        'consuming with the wrong expected action_type is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'consuming with the wrong expected action_type is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    const first = await db.query(
      'select fn_admin_consume_approved_pending_action($1, $2) as payload',
      [pendingId, 'pricing_config_update'],
    );
    log(
      'the first consume returns the exact proposed payload',
      JSON.stringify(first.rows[0].payload) === JSON.stringify(payload),
    );

    try {
      await db.query('select fn_admin_consume_approved_pending_action($1, $2)', [
        pendingId,
        'pricing_config_update',
      ]);
      log(
        'a second consume of the same approval is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'a second consume of the same approval is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    const row = await db.query('select executed_at from admin_pending_actions where id = $1', [
      pendingId,
    ]);
    log(
      'executed_at is set exactly once by the successful consume',
      row.rows[0].executed_at !== null,
    );
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, requesterId);
    await deleteTestAdmin(db, approverId);
  }
}

async function testConcurrentConsumeCanOnlySucceedOnce(db) {
  const requesterId = await insertTestAdmin(db, {
    email: `concurrent-consume-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approverId = await insertTestAdmin(db, {
    email: `concurrent-consume-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;

  try {
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requesterId,
      'manual_ledger_adjustment',
      JSON.stringify({ wallet_id: crypto.randomUUID(), amount: 50 }),
    ]);
    pendingId = res.rows[0].id;
    await db.query('select fn_admin_approve_pending_action($1, $2)', [approverId, pendingId]);

    const N = 8;
    const clients = Array.from({ length: N }, () => newClient());
    await Promise.all(clients.map((c) => c.connect()));

    const results = await Promise.allSettled(
      clients.map((c) =>
        c.query('select fn_admin_consume_approved_pending_action($1, $2)', [
          pendingId,
          'manual_ledger_adjustment',
        ]),
      ),
    );

    await Promise.all(clients.map((c) => c.end()));

    const successes = results.filter((r) => r.status === 'fulfilled').length;
    log(
      `${N} truly concurrent consumes of the same approval: exactly one wins (no double-execution)`,
      successes === 1,
      `got ${successes} successes`,
    );
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, requesterId);
    await deleteTestAdmin(db, approverId);
  }
}

async function testExpireStaleSweepAndCronRegistration(db) {
  const requesterId = await insertTestAdmin(db, {
    email: `sweep-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;

  try {
    const res = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requesterId,
      'pricing_config_update',
      JSON.stringify({ key: 'platform_topup_fee_bps', currency: 'NGN', new_value: 150 }),
    ]);
    pendingId = res.rows[0].id;
    await db.query(
      "update admin_pending_actions set requested_at = now() - interval '73 hours' where id = $1",
      [pendingId],
    );

    const sweepRes = await db.query('select fn_admin_expire_stale_pending_actions() as n');
    log('the sweep function expires at least the one stale row it should', sweepRes.rows[0].n >= 1);

    const row = await db.query('select status from admin_pending_actions where id = $1', [
      pendingId,
    ]);
    log(
      'the stale row is expired by the sweep without anyone attempting to approve/reject it',
      row.rows[0].status === 'expired',
    );

    const cronRes = await db.query(
      "select schedule, command from cron.job where jobname = 'expire-stale-pending-actions'",
    );
    log(
      'the hourly cron job is registered and calls the sweep function',
      cronRes.rowCount === 1 &&
        cronRes.rows[0].schedule === '0 * * * *' &&
        /fn_admin_expire_stale_pending_actions/.test(cronRes.rows[0].command),
    );
  } finally {
    if (pendingId) await deletePendingAction(db, pendingId);
    await deleteTestAdmin(db, requesterId);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testProposeRequiresMatchingPermission(admin);
    await testProposeRejectsUnknownActionType(admin);
    await testApproveRejectsSelfApproval(admin);
    await testApproveRequiresBothMatchingAndApprovePermission(admin);
    await testApproveSucceedsAndIsFinal(admin);
    await testRejectByRequesterAndByUnauthorizedThirdParty(admin);
    await testExpiryIsEnforcedLazily(admin);
    await testConsumeApprovedPendingActionIsSingleUse(admin);
    await testConcurrentConsumeCanOnlySucceedOnce(admin);
    await testExpireStaleSweepAndCronRegistration(admin);
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
