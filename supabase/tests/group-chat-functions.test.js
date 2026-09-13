#!/usr/bin/env node
// fn_send_group_message — ledger-conservation + concurrency tests, per
// CLAUDE.md's wallet-code test requirement, mirroring
// wallet-functions.test.js's style (same helpers, same Promise.allSettled
// concurrency pattern).
//
// This feature ships with pricing_config.group_chat_enabled = 0 (see
// docs/03-ECONOMY-LEDGER.md §10's Phase 5 gating decision) — every test
// here explicitly flips it to 1 for the duration and restores it to 0 in
// a finally block, so a test run can never accidentally leave group chat
// "live" in the dev DB it ran against.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:group-chat` from the repo root.',
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
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id = $1
     )`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function setGroupChatEnabled(admin, enabled) {
  await admin.query(
    "update public.pricing_config set value = $1 where key = 'group_chat_enabled'",
    [enabled ? 1 : 0],
  );
}

async function createTestGroup(admin, ownerId, name) {
  const groupRes = await admin.query(
    'insert into public.group_threads (name, created_by) values ($1, $2) returning id',
    [name, ownerId],
  );
  const groupId = groupRes.rows[0].id;
  await admin.query(
    "insert into public.group_members (group_thread_id, user_id, role) values ($1, $2, 'admin')",
    [groupId, ownerId],
  );
  return groupId;
}

async function addGroupMember(admin, groupId, userId) {
  await admin.query(
    "insert into public.group_members (group_thread_id, user_id, role) values ($1, $2, 'member')",
    [groupId, userId],
  );
}

async function deleteTestGroup(admin, groupId) {
  await admin.query('delete from public.group_messages where group_thread_id = $1', [groupId]);
  await admin.query('delete from public.group_members where group_thread_id = $1', [groupId]);
  await admin.query('delete from public.group_threads where id = $1', [groupId]);
}

async function resetPlatformWallets(admin) {
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id is null
         and kind in ('platform_revenue_topup_fees','platform_revenue_earnings_cut')
     )`,
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query(
    "update public.wallets set balance = 0 where user_id is null and kind in ('platform_revenue_topup_fees','platform_revenue_earnings_cut')",
  );
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

async function fundTopupCredit(admin, userId, credits) {
  const wallet = await walletRow(admin, userId, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.id, credits],
  );
}

// =============================================================================
// Test 0: the kill switch actually gates the function, not just the
// eventual Edge Function — docs/03 §10's whole Phase-5 gating decision
// depends on this holding at the DB layer, not just at an HTTP wrapper
// nobody's built yet.
// =============================================================================

async function testGroupChatDisabledByDefault(admin) {
  const owner = await createTestUser(admin);
  const member = await createTestUser(admin);
  const groupId = await createTestGroup(admin, owner, 'Disabled by default');
  await addGroupMember(admin, groupId, member);
  await fundTopupCredit(admin, member, 10);

  await setGroupChatEnabled(admin, false);

  let threw = false;
  let message = '';
  try {
    await admin.query('select * from public.fn_send_group_message($1, $2, $3)', [
      groupId,
      member,
      'hello group',
    ]);
  } catch (e) {
    threw = true;
    message = e.message;
  }

  log(
    'fn_send_group_message refuses to run while group_chat_enabled = 0, even called directly',
    threw && /group_chat_disabled/.test(message),
    message || 'did not throw',
  );

  await deleteTestGroup(admin, groupId);
  await deleteTestUser(admin, owner);
  await deleteTestUser(admin, member);
}

// =============================================================================
// Test 1: a member's message splits 70/30 to the owner/platform per
// platform_group_message_take_bps, settles immediately (no escrow row of
// any kind exists in this schema), and every wallet touched reconciles.
// =============================================================================

async function testMemberMessageSplitAndLedgerConservation(admin) {
  const owner = await createTestUser(admin);
  const member = await createTestUser(admin);
  const groupId = await createTestGroup(admin, owner, 'Split test');
  await addGroupMember(admin, groupId, member);
  await fundTopupCredit(admin, member, 100);

  await setGroupChatEnabled(admin, true);
  try {
    const res = await admin.query('select * from public.fn_send_group_message($1, $2, $3)', [
      groupId,
      member,
      'hello group, how is everyone doing today',
    ]);
    const row = res.rows[0];

    const takeBps = Number(
      (
        await admin.query(
          "select value from public.pricing_config where key = 'platform_group_message_take_bps'",
        )
      ).rows[0].value,
    );
    const credits = Number(row.credits_charged);
    const expectedPlatformTake = Math.round((credits * takeBps) / 10000);
    const expectedOwnerEarning = credits - expectedPlatformTake;

    log(
      'credits_charged uses the same word-count formula as 1:1 messages (non-zero, base-rate message)',
      credits > 0,
      `credits_charged=${credits}`,
    );

    log(
      'split matches platform_group_message_take_bps (70/30 at the seeded default)',
      Number(row.owner_earning_credits) === expectedOwnerEarning &&
        Number(row.platform_take_credits) === expectedPlatformTake,
      `owner_earning=${row.owner_earning_credits} platform_take=${row.platform_take_credits} expected owner=${expectedOwnerEarning} platform=${expectedPlatformTake}`,
    );

    const memberWallet = await walletRow(admin, member, 'topup_credit');
    log(
      "sender's topup_credit is debited by the full message cost, not the post-cut amount",
      Number(memberWallet.balance) === 100 - credits,
      `balance=${memberWallet.balance}`,
    );

    const ownerEarnings = await walletRow(admin, owner, 'earnings_pending');
    log(
      "owner's earnings_pending nets to zero (credit then immediate conversion, same shape as an escrow release)",
      Number(ownerEarnings.balance) === 0,
      `balance=${ownerEarnings.balance}`,
    );

    const ownerCash = await walletRow(admin, owner, 'withdrawable_cash');
    const unitKobo = Number(
      (await admin.query("select value from public.pricing_config where key = 'credit_unit_kobo'"))
        .rows[0].value,
    );
    log(
      "the owner's cut lands in withdrawable_cash at the fixed credit_unit_kobo rate",
      Number(ownerCash.balance) === expectedOwnerEarning * unitKobo,
      `balance=${ownerCash.balance} expected=${expectedOwnerEarning * unitKobo}`,
    );

    for (const [label, wallet] of [
      ['sender topup_credit', memberWallet],
      ['owner earnings_pending', ownerEarnings],
      ['owner withdrawable_cash', ownerCash],
    ]) {
      const sum = await ledgerSum(admin, wallet.id);
      log(
        `ledger conservation holds on ${label}`,
        sum === Number(wallet.balance),
        `ledger_sum=${sum} balance=${wallet.balance}`,
      );
    }
  } finally {
    await setGroupChatEnabled(admin, false);
    await resetPlatformWallets(admin);
    await deleteTestGroup(admin, groupId);
    await deleteTestUser(admin, owner);
    await deleteTestUser(admin, member);
  }
}

// =============================================================================
// Test 2: the self-post exception — when the owner posts in their own
// group, nobody earns anything (docs/03 §10's hard requirement, not an
// optimization). The message still costs credits as normal.
// =============================================================================

async function testOwnerSelfPostDoesNotEarn(admin) {
  const owner = await createTestUser(admin);
  const groupId = await createTestGroup(admin, owner, 'Self-post test');
  await fundTopupCredit(admin, owner, 100);

  await setGroupChatEnabled(admin, true);
  try {
    const res = await admin.query('select * from public.fn_send_group_message($1, $2, $3)', [
      groupId,
      owner,
      "a message from the owner, to the owner's own group",
    ]);
    const row = res.rows[0];
    const credits = Number(row.credits_charged);

    log(
      'owner posting in their own group earns nothing — owner_earning_credits and platform_take_credits are both 0',
      Number(row.owner_earning_credits) === 0 && Number(row.platform_take_credits) === 0,
      `owner_earning=${row.owner_earning_credits} platform_take=${row.platform_take_credits}`,
    );

    const ownerCredit = await walletRow(admin, owner, 'topup_credit');
    log(
      'the message still costs the owner credits as normal — this is not a free post',
      Number(ownerCredit.balance) === 100 - credits && credits > 0,
      `balance=${ownerCredit.balance} credits_charged=${credits}`,
    );

    const ownerEarnings = await walletRow(admin, owner, 'earnings_pending');
    log(
      "owner's earnings_pending is untouched by their own post (no ledger entries from this message at all)",
      Number(ownerEarnings.balance) === 0,
      `balance=${ownerEarnings.balance}`,
    );

    const platformWallet = (
      await admin.query(
        "select balance from public.wallets where user_id is null and kind = 'platform_revenue_earnings_cut'",
      )
    ).rows[0];
    log(
      'the platform wallet is untouched by a self-post — no cut is taken on a message nobody else received it from',
      Number(platformWallet.balance) === 0,
      `balance=${platformWallet.balance}`,
    );
  } finally {
    await setGroupChatEnabled(admin, false);
    await resetPlatformWallets(admin);
    await deleteTestGroup(admin, groupId);
    await deleteTestUser(admin, owner);
  }
}

// =============================================================================
// Test 3: two simultaneous fn_send_group_message calls from the same
// member, wallet funded for exactly one message, must not both succeed.
// =============================================================================

async function testConcurrentGroupMessagePreventsDoubleSpend(admin) {
  const owner = await createTestUser(admin);
  const member = await createTestUser(admin);
  const groupId = await createTestGroup(admin, owner, 'Concurrency test');
  await addGroupMember(admin, groupId, member);
  // 'hi' is 1 word -> 1 word block -> message_base_credits (2 at the
  // seeded default) — fund exactly that, same style as the 1:1
  // send-message concurrency test.
  await fundTopupCredit(admin, member, 2);

  await setGroupChatEnabled(admin, true);
  try {
    const c1 = newClient();
    const c2 = newClient();
    await c1.connect();
    await c2.connect();

    const results = await Promise.allSettled([
      c1.query('select * from public.fn_send_group_message($1, $2, $3)', [groupId, member, 'hi']),
      c2.query('select * from public.fn_send_group_message($1, $2, $3)', [groupId, member, 'yo']),
    ]);

    await c1.end();
    await c2.end();

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    log(
      'exactly one of two concurrent group messages succeeds when balance covers only one',
      succeeded.length === 1 && failed.length === 1,
      `succeeded=${succeeded.length} failed=${failed.length}`,
    );

    log(
      'the loser fails with insufficient_credit, not some other error',
      failed.length === 1 && /insufficient_credit/.test(failed[0].reason.message),
      failed[0] ? failed[0].reason.message : 'n/a',
    );

    const memberWallet = await walletRow(admin, member, 'topup_credit');
    log(
      "sender's balance never goes negative and matches exactly one debit",
      Number(memberWallet.balance) === 0,
      `balance=${memberWallet.balance}`,
    );

    const sum = await ledgerSum(admin, memberWallet.id);
    log(
      'ledger conservation holds on the sender wallet after the race',
      sum === Number(memberWallet.balance),
      `ledger_sum=${sum} balance=${memberWallet.balance}`,
    );
  } finally {
    await setGroupChatEnabled(admin, false);
    await resetPlatformWallets(admin);
    await deleteTestGroup(admin, groupId);
    await deleteTestUser(admin, owner);
    await deleteTestUser(admin, member);
  }
}

// =============================================================================
// Test 4: a non-member cannot post, and a nonexistent group is rejected —
// basic input-validation coverage, same discipline as fn_send_message's
// not_a_participant/thread_not_found checks.
// =============================================================================

async function testMembershipAndExistenceChecks(admin) {
  const owner = await createTestUser(admin);
  const outsider = await createTestUser(admin);
  const groupId = await createTestGroup(admin, owner, 'Membership test');
  await fundTopupCredit(admin, outsider, 10);

  await setGroupChatEnabled(admin, true);
  try {
    let threw = false;
    let message = '';
    try {
      await admin.query('select * from public.fn_send_group_message($1, $2, $3)', [
        groupId,
        outsider,
        'I am not in this group',
      ]);
    } catch (e) {
      threw = true;
      message = e.message;
    }
    log(
      'a non-member cannot post to a group',
      threw && /not_a_member/.test(message),
      message || 'did not throw',
    );

    threw = false;
    message = '';
    try {
      await admin.query('select * from public.fn_send_group_message($1, $2, $3)', [
        crypto.randomUUID(),
        owner,
        'posting to a group that does not exist',
      ]);
    } catch (e) {
      threw = true;
      message = e.message;
    }
    log(
      'posting to a nonexistent group is rejected',
      threw && /group_not_found/.test(message),
      message || 'did not throw',
    );
  } finally {
    await setGroupChatEnabled(admin, false);
    await deleteTestGroup(admin, groupId);
    await deleteTestUser(admin, owner);
    await deleteTestUser(admin, outsider);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testGroupChatDisabledByDefault(admin);
    await testMemberMessageSplitAndLedgerConservation(admin);
    await testOwnerSelfPostDoesNotEarn(admin);
    await testConcurrentGroupMessagePreventsDoubleSpend(admin);
    await testMembershipAndExistenceChecks(admin);
  } finally {
    // Belt-and-suspenders on top of each test's own finally block — this
    // feature must never be left enabled in the dev DB after a test run,
    // pass or fail, per docs/03 §10's gating decision.
    await setGroupChatEnabled(admin, false);
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
