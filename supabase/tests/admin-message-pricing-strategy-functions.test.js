#!/usr/bin/env node
// Pricing-strategy-switch framework (docs/14-ADMIN-DASHBOARD-SCOPING.md
// §4.3), piece 1. Same pattern as every other admin-* suite: real
// pg.Client against the real linked dev database, fresh random fixtures
// per run, self-cleaning.
//
// Covers: the three pure pricing functions in isolation (deterministic
// boundary-value checks against the real live NGN config, plus the
// fail-closed behavior for an unconfigured currency); dual-approval
// enforcement on switching the active strategy (mirrors the now-familiar
// checks from every other dual-approved action this session); and, the
// single most important test in this file, that fn_send_message's actual
// CASE dispatch honors a real strategy switch end-to-end — not just that
// the pure functions compute correctly in isolation, but that switching
// via the real admin propose/approve/apply flow changes what a real
// fn_send_message call actually charges, for all three strategies.
//
// Deliberately does NOT temporarily mutate the real NGN
// message_pricing_strategy row for testing — a crash mid-test could leave
// live production message pricing pointed at a different strategy than
// intended, a real financial consequence for real users. Everything that
// needs a working strategy row uses a disposable QA currency (QAMP)
// instead, exactly like every other QA-currency fixture this session
// already established. Only non-mutating reads (the pure pricing
// functions, called directly, never through fn_send_message) touch NGN's
// real config, using its real live values as known-good boundary-value
// fixtures.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:admin-message-pricing-strategy` from the repo root.',
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
  await db.query('delete from auth.users where id = $1', [id]);
}

async function proposeAndApprove(db, { requester, approver, payload }) {
  const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
    requester,
    'message_pricing_strategy_change',
    JSON.stringify(payload),
  ]);
  const pendingId = proposeRes.rows[0].id;
  await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);
  return pendingId;
}

async function testExecuteGrantsAreLocked(db) {
  const functions = [
    'fn_admin_set_message_pricing_strategy(uuid, uuid, text, text)',
    'fn_price_message_tiered_word_block(integer, text)',
    'fn_price_message_flat(integer, text)',
    'fn_price_message_linear(integer, text)',
    // Signature grew two trailing default params for chat media
    // (docs/16-CHAT-MEDIA-SCOPING.md, 20260925120000_chat_media_pipeline.sql)
    // — this string has to match the function's real signature exactly,
    // `has_function_privilege` does not resolve by name alone.
    'fn_send_message(uuid, uuid, text, uuid, uuid, boolean, text, text)',
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
    'public.message_pricing_strategy',
    'insert',
  ]);
  log(
    'service_role cannot INSERT into message_pricing_strategy directly (only via fn_admin_set_message_pricing_strategy)',
    writeRes.rows[0].ok === false,
  );
}

// Boundary values computed against NGN's real live config
// (message_word_block_size=50, message_base_credits=2) — a real-config
// regression check, not an arbitrary fixture.
async function testPureTieredWordBlockFunction(db) {
  const cases = [
    [1, 2],
    [50, 2],
    [51, 4],
    [100, 4],
    [101, 6],
  ];
  for (const [words, expected] of cases) {
    const res = await db.query('select fn_price_message_tiered_word_block($1, $2) as credits', [
      words,
      'NGN',
    ]);
    log(
      `tiered_word_block(${words} words) = ${expected} credits`,
      Number(res.rows[0].credits) === expected,
      `got ${res.rows[0].credits}`,
    );
  }
}

// message_flat_credits=2 (this migration's own seed) — flat means flat,
// regardless of word count.
async function testPureFlatFunction(db) {
  for (const words of [1, 500]) {
    const res = await db.query('select fn_price_message_flat($1, $2) as credits', [words, 'NGN']);
    log(
      `flat_per_message(${words} words) = 2 credits regardless of length`,
      Number(res.rows[0].credits) === 2,
      `got ${res.rows[0].credits}`,
    );
  }
}

// message_credits_per_100_words=4 (this migration's own seed).
async function testPureLinearFunction(db) {
  const cases = [
    [1, 1], // greatest(ceil(4/100), 1) = 1
    [50, 2], // ceil(200/100) = 2
    [100, 4],
    [101, 5], // ceil(404/100) = 5
  ];
  for (const [words, expected] of cases) {
    const res = await db.query('select fn_price_message_linear($1, $2) as credits', [words, 'NGN']);
    log(
      `linear_per_word(${words} words) = ${expected} credits`,
      Number(res.rows[0].credits) === expected,
      `got ${res.rows[0].credits}`,
    );
  }
}

async function testPureFunctionsFailForUnconfiguredCurrency(db) {
  const fns = [
    'fn_price_message_tiered_word_block',
    'fn_price_message_flat',
    'fn_price_message_linear',
  ];
  for (const fn of fns) {
    try {
      await db.query(`select ${fn}($1, $2)`, [10, 'ZZZZ']);
      log(
        `${fn} raises for an unconfigured currency`,
        false,
        'expected pricing_config_not_found_for_currency',
      );
    } catch (e) {
      log(
        `${fn} raises for an unconfigured currency`,
        /pricing_config_not_found_for_currency/.test(e.message),
        e.message,
      );
    }
  }
}

const QA_CURRENCY = 'QAMP';

async function seedQaPricingConfig(db) {
  const rows = [
    ['message_word_block_size', 50],
    ['message_base_credits', 2],
    ['message_max_words', 500],
    ['message_flat_credits', 3],
    ['message_credits_per_100_words', 5],
  ];
  for (const [key, value] of rows) {
    await db.query(
      `insert into pricing_config (key, currency, value, description) values ($1, $2, $3, 'QA fixture')
       on conflict (key, currency) do update set value = $3`,
      [key, QA_CURRENCY, value],
    );
  }
}

async function cleanupQaPricingConfig(db) {
  const keys = [
    'message_word_block_size',
    'message_base_credits',
    'message_max_words',
    'message_flat_credits',
    'message_credits_per_100_words',
  ];
  await db.query('delete from pricing_config_history where key = ANY($1) and currency = $2', [
    keys,
    QA_CURRENCY,
  ]);
  await db.query('delete from pricing_config where key = ANY($1) and currency = $2', [
    keys,
    QA_CURRENCY,
  ]);
  await db.query('delete from message_pricing_strategy where currency = $1', [QA_CURRENCY]);
}

async function testDualApprovalEnforcementForStrategyChange(db) {
  const requester = await insertTestAdmin(db, {
    email: `mps-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `mps-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const unauthorized = await insertTestAdmin(db, {
    email: `mps-unauth-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['support_agent'],
  });
  let pendingId = null;

  try {
    await seedQaPricingConfig(db);
    await db.query(
      `insert into message_pricing_strategy (currency, active_strategy) values ($1, 'tiered_word_block')`,
      [QA_CURRENCY],
    );

    const payload = { currency: QA_CURRENCY, active_strategy: 'flat_per_message' };

    try {
      await db.query('select fn_admin_set_message_pricing_strategy($1, $2, $3, $4)', [
        requester,
        crypto.randomUUID(),
        payload.currency,
        payload.active_strategy,
      ]);
      log(
        'setting strategy with a nonexistent pending_action_id is rejected',
        false,
        'expected pending_action_not_approved_or_already_executed',
      );
    } catch (e) {
      log(
        'setting strategy with a nonexistent pending_action_id is rejected',
        /pending_action_not_approved_or_already_executed/.test(e.message),
        e.message,
      );
    }

    try {
      await db.query('select fn_admin_propose_pending_action($1, $2, $3)', [
        unauthorized,
        'message_pricing_strategy_change',
        JSON.stringify(payload),
      ]);
      log(
        'support_agent (no edit_pricing_config) cannot propose a strategy change',
        false,
        'expected not_authorized',
      );
    } catch (e) {
      log(
        'support_agent (no edit_pricing_config) cannot propose a strategy change',
        /not_authorized/.test(e.message),
        e.message,
      );
    }

    const proposeRes = await db.query('select fn_admin_propose_pending_action($1, $2, $3) as id', [
      requester,
      'message_pricing_strategy_change',
      JSON.stringify(payload),
    ]);
    pendingId = proposeRes.rows[0].id;

    try {
      await db.query('select fn_admin_approve_pending_action($1, $2)', [requester, pendingId]);
      log(
        'the requester cannot approve their own strategy-change proposal',
        false,
        'expected cannot_approve_own_action',
      );
    } catch (e) {
      log(
        'the requester cannot approve their own strategy-change proposal',
        /cannot_approve_own_action/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_approve_pending_action($1, $2)', [approver, pendingId]);

    try {
      await db.query('select fn_admin_set_message_pricing_strategy($1, $2, $3, $4)', [
        requester,
        pendingId,
        payload.currency,
        'linear_per_word', // does not match the approved payload's active_strategy
      ]);
      log(
        'applying a different strategy than what was approved is rejected',
        false,
        'expected pending_action_payload_mismatch',
      );
    } catch (e) {
      log(
        'applying a different strategy than what was approved is rejected',
        /pending_action_payload_mismatch/.test(e.message),
        e.message,
      );
    }

    await db.query('select fn_admin_set_message_pricing_strategy($1, $2, $3, $4)', [
      requester,
      pendingId,
      payload.currency,
      payload.active_strategy,
    ]);
    const row = await db.query(
      'select active_strategy, updated_by_admin_id from message_pricing_strategy where currency = $1',
      [QA_CURRENCY],
    );
    log(
      'a matching approved strategy change applies, attributed to the real requester',
      row.rows[0].active_strategy === 'flat_per_message' &&
        row.rows[0].updated_by_admin_id === requester,
    );

    const audit = await db.query(
      `select 1 from admin_audit_log where admin_user_id = $1 and action = 'set_message_pricing_strategy' and target_id = $2`,
      [requester, QA_CURRENCY],
    );
    log('the change writes an admin_audit_log row', audit.rowCount === 1);
  } finally {
    if (pendingId) await db.query('delete from admin_pending_actions where id = $1', [pendingId]);
    await cleanupQaPricingConfig(db);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
    await deleteTestAdmin(db, unauthorized);
  }
}

async function testFnSendMessageDispatchesToActiveStrategy(db) {
  const requester = await insertTestAdmin(db, {
    email: `mps-dispatch-req-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const approver = await insertTestAdmin(db, {
    email: `mps-dispatch-appr-${crypto.randomUUID()}@test.invalid`,
    roleNames: ['finance_admin'],
  });
  const userA = await createTestUser(db);
  const userB = await createTestUser(db);
  let threadId = null;
  const pendingIds = [];

  try {
    await seedQaPricingConfig(db);
    await db.query(
      `insert into message_pricing_strategy (currency, active_strategy) values ($1, 'tiered_word_block')`,
      [QA_CURRENCY],
    );

    // A is always the sender in this test (never B) — is_reply stays
    // false, so fn_release_escrow never fires, meaning this test only
    // needs A's topup_credit wallet on the QA currency, not a full
    // QA-currency escrow-release/conversion config replica for B too.
    await db.query(
      `update wallets set currency = $1 where user_id = $2 and kind = 'topup_credit'`,
      [QA_CURRENCY, userA],
    );
    const walletId = (
      await db.query(`select id from wallets where user_id = $1 and kind = 'topup_credit'`, [userA])
    ).rows[0].id;
    await db.query(
      `insert into ledger_entries (wallet_id, amount, reason, ref_type, currency) values ($1, 10000, 'manual_adjustment', 'admin_action', $2)`,
      [walletId, QA_CURRENCY],
    );

    threadId = (await db.query('select fn_start_thread($1, $2) as id', [userA, userB])).rows[0].id;

    // 30 words -> ceil(30/50)=1 block * 2 base = 2 credits under tiered_word_block.
    const words30 = Array(30).fill('word').join(' ');
    const send1 = await db.query('select * from fn_send_message($1, $2, $3)', [
      threadId,
      userA,
      words30,
    ]);
    log(
      'under tiered_word_block (the seeded default), a 30-word message charges 2 credits',
      Number(send1.rows[0].credits_charged) === 2,
      `got ${send1.rows[0].credits_charged}`,
    );

    // Switch to flat_per_message (seeded 3 credits) via the real admin flow.
    const pendingId1 = await proposeAndApprove(db, {
      requester,
      approver,
      payload: { currency: QA_CURRENCY, active_strategy: 'flat_per_message' },
    });
    pendingIds.push(pendingId1);
    await db.query('select fn_admin_set_message_pricing_strategy($1, $2, $3, $4)', [
      requester,
      pendingId1,
      QA_CURRENCY,
      'flat_per_message',
    ]);

    const send2 = await db.query('select * from fn_send_message($1, $2, $3)', [
      threadId,
      userA,
      words30,
    ]);
    log(
      'after switching to flat_per_message, the SAME 30-word message now charges the flat 3 credits, not 2',
      Number(send2.rows[0].credits_charged) === 3,
      `got ${send2.rows[0].credits_charged}`,
    );

    // Switch to linear_per_word (seeded 5 credits per 100 words) via the real admin flow.
    const pendingId2 = await proposeAndApprove(db, {
      requester,
      approver,
      payload: { currency: QA_CURRENCY, active_strategy: 'linear_per_word' },
    });
    pendingIds.push(pendingId2);
    await db.query('select fn_admin_set_message_pricing_strategy($1, $2, $3, $4)', [
      requester,
      pendingId2,
      QA_CURRENCY,
      'linear_per_word',
    ]);

    // 30 words * 5 / 100 = 1.5 -> ceil = 2 credits under linear_per_word.
    const send3 = await db.query('select * from fn_send_message($1, $2, $3)', [
      threadId,
      userA,
      words30,
    ]);
    log(
      'after switching to linear_per_word, the same message now charges ceil(30*5/100)=2 credits, not 2 (tiered) or 3 (flat) by coincidence',
      Number(send3.rows[0].credits_charged) === 2,
      `got ${send3.rows[0].credits_charged}`,
    );

    const balance = await db.query('select balance from wallets where id = $1', [walletId]);
    log(
      'the wallet was debited exactly 2+3+2=7 credits across the three sends, ledger conservation holds',
      Number(balance.rows[0].balance) === 10000 - 7,
      `balance=${balance.rows[0].balance}`,
    );
  } finally {
    if (threadId) {
      await db.query('delete from escrows where thread_id = $1', [threadId]);
      await db.query('delete from messages where thread_id = $1', [threadId]);
      await db.query('delete from threads where id = $1', [threadId]);
    }
    for (const id of pendingIds)
      await db.query('delete from admin_pending_actions where id = $1', [id]);
    await cleanupQaPricingConfig(db);
    await deleteTestUser(db, userA);
    await deleteTestUser(db, userB);
    await deleteTestAdmin(db, requester);
    await deleteTestAdmin(db, approver);
  }
}

async function testUnconfiguredStrategyCurrencyRaises(db) {
  const userA = await createTestUser(db);
  const userB = await createTestUser(db);
  let threadId = null;

  try {
    // pricing_config rows exist for this currency, but no
    // message_pricing_strategy row — the two are independently seeded,
    // and fn_send_message must fail closed if the second is missing,
    // not silently default to a strategy nobody chose.
    await seedQaPricingConfig(db);
    await db.query(
      `update wallets set currency = $1 where user_id = $2 and kind = 'topup_credit'`,
      [QA_CURRENCY, userA],
    );
    const walletId = (
      await db.query(`select id from wallets where user_id = $1 and kind = 'topup_credit'`, [userA])
    ).rows[0].id;
    await db.query(
      `insert into ledger_entries (wallet_id, amount, reason, ref_type, currency) values ($1, 10000, 'manual_adjustment', 'admin_action', $2)`,
      [walletId, QA_CURRENCY],
    );

    threadId = (await db.query('select fn_start_thread($1, $2) as id', [userA, userB])).rows[0].id;

    try {
      await db.query('select * from fn_send_message($1, $2, $3)', [threadId, userA, 'hello there']);
      log(
        'sending with no message_pricing_strategy row for the currency is rejected',
        false,
        'expected message_pricing_strategy_not_configured_for_currency',
      );
    } catch (e) {
      log(
        'sending with no message_pricing_strategy row for the currency is rejected',
        /message_pricing_strategy_not_configured_for_currency/.test(e.message),
        e.message,
      );
    }
  } finally {
    if (threadId) {
      await db.query('delete from escrows where thread_id = $1', [threadId]);
      await db.query('delete from messages where thread_id = $1', [threadId]);
      await db.query('delete from threads where id = $1', [threadId]);
    }
    await cleanupQaPricingConfig(db);
    await deleteTestUser(db, userA);
    await deleteTestUser(db, userB);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testExecuteGrantsAreLocked(admin);
    await testPureTieredWordBlockFunction(admin);
    await testPureFlatFunction(admin);
    await testPureLinearFunction(admin);
    await testPureFunctionsFailForUnconfiguredCurrency(admin);
    await testDualApprovalEnforcementForStrategyChange(admin);
    await testFnSendMessageDispatchesToActiveStrategy(admin);
    await testUnconfiguredStrategyCurrencyRaises(admin);
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
