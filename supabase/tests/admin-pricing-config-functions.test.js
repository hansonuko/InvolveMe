#!/usr/bin/env node
// Admin dashboard Phase D piece 1 — DB-level tests for
// 20260920160000_admin_pricing_config_attribution.sql. Same pattern as
// admin-rbac-functions.test.js / admin-reports-fraud-functions.test.js:
// real pg.Client against the real linked dev database, fresh random
// fixtures per run, self-cleaning.
//
// Covers: the actual point of this piece — pricing_config_history.
// changed_by is really attributed to the calling admin now, not the
// hardcoded 'system' literal it was before; the two sanity guards
// (_bps > 10000, any negative value) actually reject; a caller without
// edit_pricing_config is rejected; and a nonexistent key/currency pair is
// rejected rather than silently no-op-ing. Uses a disposable pricing_
// config row (key qa_test_config_key, currency QA) so nothing here ever
// touches a real config value the app actually reads.
//
// Updated for Phase E piece 1 (20260923110000_admin_pricing_dual_approval_
// and_manual_adjustment.sql): fn_admin_update_pricing_config gained a
// trailing p_pending_action_id parameter and a real behavior change for
// _bps keys — they now require a matching approved dual-approval row
// instead of applying immediately. Non-bps assertions below just pass
// null for the new parameter (unchanged behavior); the _bps assertions
// were rewritten to reflect the new gate rather than patched around it —
// see testBpsChangeRequiresDualApproval and the rewritten "exactly 10000"
// case in testGuardsAndAuthorization.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-pricing` from the repo root.',
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

const QA_KEY = 'qa_test_config_key';
const QA_BPS_KEY = 'qa_test_config_bps';
const QA_CURRENCY = 'QA';

async function seedTestConfig(db) {
  await db.query(
    `insert into pricing_config (key, currency, value, description) values ($1, $2, 100, 'QA fixture') on conflict (key, currency) do update set value = 100`,
    [QA_KEY, QA_CURRENCY],
  );
  await db.query(
    `insert into pricing_config (key, currency, value, description) values ($1, $2, 100, 'QA fixture bps') on conflict (key, currency) do update set value = 100`,
    [QA_BPS_KEY, QA_CURRENCY],
  );
}

async function cleanupTestConfig(db) {
  // pricing_config_history has no delete restriction (not append-only by
  // trigger, unlike admin_audit_log/ledger_entries) — a plain delete is
  // fine here.
  await db.query('delete from pricing_config_history where key in ($1, $2) and currency = $3', [
    QA_KEY,
    QA_BPS_KEY,
    QA_CURRENCY,
  ]);
  await db.query('delete from pricing_config where key in ($1, $2) and currency = $3', [
    QA_KEY,
    QA_BPS_KEY,
    QA_CURRENCY,
  ]);
}

async function testRealAttribution(db) {
  const admin = await insertTestAdmin(db, {
    email: `pricing-attr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });

  try {
    await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
      admin,
      QA_KEY,
      QA_CURRENCY,
      250,
      null,
    ]);

    const row = await db.query(
      'select value from pricing_config where key = $1 and currency = $2',
      [QA_KEY, QA_CURRENCY],
    );
    log(
      'the value actually updates',
      Number(row.rows[0].value) === 250,
      `value=${row.rows[0].value}`,
    );

    const history = await db.query(
      `select old_value, new_value, changed_by from pricing_config_history where key = $1 and currency = $2 order by changed_at desc limit 1`,
      [QA_KEY, QA_CURRENCY],
    );
    const admin_row = await db.query('select email from admin_users where id = $1', [admin]);
    log(
      "changed_by is the real admin's email, not the hardcoded 'system'",
      history.rows[0].changed_by === admin_row.rows[0].email,
      `changed_by=${history.rows[0].changed_by}`,
    );
    log(
      'the history row still captures old/new value correctly (unchanged behavior)',
      Number(history.rows[0].old_value) === 100 && Number(history.rows[0].new_value) === 250,
      JSON.stringify(history.rows[0]),
    );

    const audit = await db.query(
      `select after_state from admin_audit_log where admin_user_id = $1 and action = 'update_pricing_config' and target_id = $2`,
      [admin, `${QA_KEY}:${QA_CURRENCY}`],
    );
    log(
      'the change also writes an admin_audit_log row',
      audit.rowCount === 1,
      JSON.stringify(audit.rows[0]),
    );
  } finally {
    await deleteTestAdmin(db, admin);
  }
}

async function testTransactionLocalSettingDoesNotLeak(db) {
  const admin = await insertTestAdmin(db, {
    email: `pricing-leak-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });

  try {
    await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
      admin,
      QA_KEY,
      QA_CURRENCY,
      300,
      null,
    ]);

    // A direct, non-function UPDATE on the same connection, in a fresh
    // statement — the transaction-local setting from the call above must
    // not still be visible, or a later real edit (bypassing the function,
    // e.g. a Studio edit) would get mis-attributed to the last admin who
    // used the function on this pooled connection.
    await db.query('update pricing_config set value = 999 where key = $1 and currency = $2', [
      QA_KEY,
      QA_CURRENCY,
    ]);
    const history = await db.query(
      `select changed_by from pricing_config_history where key = $1 and currency = $2 order by changed_at desc limit 1`,
      [QA_KEY, QA_CURRENCY],
    );
    log(
      "a direct UPDATE on the same connection afterward attributes to 'system', not leaked from the prior call",
      history.rows[0].changed_by === 'system',
      `changed_by=${history.rows[0].changed_by}`,
    );
  } finally {
    await deleteTestAdmin(db, admin);
  }
}

async function testGuardsAndAuthorization(db) {
  const authorized = await insertTestAdmin(db, {
    email: `pricing-guard-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `pricing-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });

  try {
    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        unauthorized,
        QA_KEY,
        QA_CURRENCY,
        500,
        null,
      ]);
      log(
        'support_agent cannot edit pricing_config (no edit_pricing_config)',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'support_agent cannot edit pricing_config (no edit_pricing_config)',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        authorized,
        QA_KEY,
        QA_CURRENCY,
        -5,
        null,
      ]);
      log('a negative value is rejected', false, 'expected negative_value_not_allowed');
    } catch (e) {
      log('a negative value is rejected', /negative_value_not_allowed/.test(e.message), e.message);
    }

    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        authorized,
        QA_BPS_KEY,
        QA_CURRENCY,
        15000,
        null,
      ]);
      log(
        'a _bps key over 10000 is rejected before the dual-approval gate is even reached',
        false,
        'expected bps_value_out_of_range',
      );
    } catch (e) {
      log(
        'a _bps key over 10000 is rejected before the dual-approval gate is even reached',
        /bps_value_out_of_range/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        authorized,
        'not_a_real_key',
        QA_CURRENCY,
        5,
        null,
      ]);
      log(
        'a nonexistent key is rejected, not a silent no-op',
        false,
        'expected pricing_config_key_not_found',
      );
    } catch (e) {
      log(
        'a nonexistent key is rejected, not a silent no-op',
        /pricing_config_key_not_found/.test(e.message),
        e.message,
      );
    }
  } finally {
    await deleteTestAdmin(db, authorized);
    await deleteTestAdmin(db, unauthorized);
  }
}

async function testBpsChangeRequiresDualApproval(db) {
  const requester = await insertTestAdmin(db, {
    email: `pricing-bps-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `pricing-bps-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  let pendingId = null;
  let otherPendingId = null;

  try {
    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        requester,
        QA_BPS_KEY,
        QA_CURRENCY,
        10000,
        null,
      ]);
      log(
        'a _bps key change with no pending_action_id is rejected',
        false,
        'expected dual_approval_required',
      );
    } catch (e) {
      log(
        'a _bps key change with no pending_action_id is rejected',
        /dual_approval_required/.test(e.message),
        e.message,
      );
    }

    const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requester,
      'pricing_config_update',
      JSON.stringify({ key: QA_BPS_KEY, currency: QA_CURRENCY, new_value: 10000 }),
    ]);
    pendingId = proposeRes.rows[0].id;

    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        requester,
        QA_BPS_KEY,
        QA_CURRENCY,
        10000,
        pendingId,
      ]);
      log(
        'an unapproved pending action cannot be consumed to apply the change',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'an unapproved pending action cannot be consumed to apply the change',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);

    const otherProposeRes = await db.query(
      'select fn_admin_propose_pending_action($1, $2, $3) as id',
      [
        requester,
        'pricing_config_update',
        JSON.stringify({ key: QA_BPS_KEY, currency: QA_CURRENCY, new_value: 9000 }),
      ],
    );
    otherPendingId = otherProposeRes.rows[0].id;
    await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, otherPendingId]);

    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        requester,
        QA_BPS_KEY,
        QA_CURRENCY,
        10000,
        otherPendingId,
      ]);
      log(
        'an approval for a different new_value cannot be reused to apply this change (payload must match)',
        false,
        'expected pending_action_payload_mismatch',
      );
    } catch (e) {
      log(
        'an approval for a different new_value cannot be reused to apply this change (payload must match)',
        /pending_action_payload_mismatch/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
      requester,
      QA_BPS_KEY,
      QA_CURRENCY,
      10000,
      pendingId,
    ]);
    const row = await db.query(
      'select value from pricing_config where key = $1 and currency = $2',
      [QA_BPS_KEY, QA_CURRENCY],
    );
    log(
      'exactly 10000 (100%) applies once a matching approval is consumed, not treated as over the limit',
      Number(row.rows[0].value) === 10000,
    );

    try {
      await db.query('select fn_admin_update_pricing_config($1, $2, $3, $4, $5)', [
        requester,
        QA_BPS_KEY,
        QA_CURRENCY,
        10000,
        pendingId,
      ]);
      log(
        'the same approval cannot be consumed a second time to apply the change again',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'the same approval cannot be consumed a second time to apply the change again',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    if (otherPendingId)
      await db.query('delete from admin_pending_actions where id = $1', [otherPendingId]);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testExecuteGrantsAreLocked(db) {
  const fn = 'fn_admin_update_pricing_config(uuid, text, text, bigint, uuid)';
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

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await seedTestConfig(admin);
    await testRealAttribution(admin);
    await testTransactionLocalSettingDoesNotLeak(admin);
    await testGuardsAndAuthorization(admin);
    await testBpsChangeRequiresDualApproval(admin);
  } finally {
    await cleanupTestConfig(admin);
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
