#!/usr/bin/env node
// Phase 5 fraud infra (docs/06-SECURITY-FRAUD-LOOPHOLES.md §2/§4;
// docs/00-SESSION-HANDOFF.md session 13) — direct DB-level tests against
// the real linked dev database, same pattern as wallet-functions.test.js
// (plain pg.Client + fn_ calls, no HTTP/deno layer, since none of this
// pass's functions are Edge Functions except register-device-fingerprint,
// covered separately). Run via `npm run test:fraud`.
//
// Covers: fn_link_device_fingerprint (link + idempotent replay + two
// users sharing a hash reference the same row), fn_buy_credit's new
// velocity cap (new+unverified capped, Tier-1 and aged-out accounts
// aren't), fn_run_collusion_detection (both signal types as real true
// positives via real fn_send_message activity, PLUS a false-positive
// check — a normal, diverse conversation must not get flagged, not just
// "does it find fraud" but "does it leave real users alone"), and
// fn_transfer_credit's new recipient KYC gate.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is not set. Run via `npm run test:fraud` from the repo root.');
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

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function deleteTestUser(admin, id) {
  admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from public.withdrawals where user_id = $1', [id]);
  await admin.query('delete from public.bank_accounts where user_id = $1', [id]);
  await admin.query('delete from public.topups where user_id = $1', [id]);
  await admin.query(
    'delete from public.credit_transfers where sender_id = $1 or recipient_id = $1',
    [id],
  );
  await admin.query('delete from public.fraud_signals where user_id = $1 or related_user_id = $1', [
    id,
  ]);
  await admin.query('delete from auth.users where id = $1', [id]); // cascades to public.users
}

async function deleteFingerprint(admin, hash) {
  await admin.query('delete from public.device_fingerprints where fingerprint_hash = $1', [hash]);
}

async function fundWallet(admin, userId, kind, amount) {
  const { rows } = await admin.query(
    'select id from public.wallets where user_id = $1 and kind = $2',
    [userId, kind],
  );
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [rows[0].id, amount],
  );
}

// For settlement-aware auto-sweep tests: a user whose account is
// `ageDays` old (backdates both auth.users.created_at and the
// trigger-copied public.users.created_at, same field the trust check
// reads) and, separately, a withdrawable_cash wallet whose
// `updated_at` is backdated to simulate money that's sat unswept for
// `updatedHoursAgo` hours — the same proxy fn_run_auto_withdraw_sweep
// itself already uses for "how long has this sat here."
async function createAgedUser(admin, ageDays) {
  const id = crypto.randomUUID();
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  await admin.query(
    `insert into auth.users (id, phone, created_at, aud, role, instance_id)
     values ($1, $2, now() - make_interval(days => $3), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`,
    [id, phone, ageDays],
  );
  await admin.query(
    'update public.users set created_at = now() - make_interval(days => $2), kyc_tier = 1 where id = $1',
    [id, ageDays],
  );
  return id;
}

async function setupWithdrawableWallet(admin, userId, kobo, updatedHoursAgo) {
  const bankRes = await admin.query(
    `insert into public.bank_accounts (user_id, bank_name, account_name, name_match_verified)
     values ($1, 'Test Bank', 'Sweep Test', true) returning id`,
    [userId],
  );
  const wallet = await admin.query(
    `select id from public.wallets where user_id = $1 and kind = 'withdrawable_cash'`,
    [userId],
  );
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.rows[0].id, kobo],
  );
  await admin.query(
    'update public.wallets set updated_at = now() - make_interval(hours => $2) where id = $1',
    [wallet.rows[0].id, updatedHoursAgo],
  );
  return { walletId: wallet.rows[0].id, bankAccountId: bankRes.rows[0].id };
}

async function sendMessages(admin, threadId, senderId, count, body = 'hi') {
  for (let i = 0; i < count; i++) {
    await admin.query('select public.fn_send_message($1, $2, $3)', [threadId, senderId, body]);
  }
}

// =============================================================================
// Test 1: fn_link_device_fingerprint — links, is idempotent on replay, and
// two different users sharing a hash both end up referencing the SAME
// device_fingerprints row (the fact the collusion job depends on).
// =============================================================================

async function testLinkDeviceFingerprint(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const hash = crypto.randomBytes(32).toString('hex');

  await admin.query('select public.fn_link_device_fingerprint($1, $2)', [A, hash]);
  const first = await admin.query('select device_fingerprint_ids from public.users where id = $1', [
    A,
  ]);
  log(
    'first link adds exactly one fingerprint id',
    first.rows[0].device_fingerprint_ids.length === 1,
    JSON.stringify(first.rows[0]),
  );

  // Replay: same user, same hash — must not grow the array.
  await admin.query('select public.fn_link_device_fingerprint($1, $2)', [A, hash]);
  const replayed = await admin.query(
    'select device_fingerprint_ids from public.users where id = $1',
    [A],
  );
  log(
    'replaying the same link is idempotent, not a duplicate array entry',
    replayed.rows[0].device_fingerprint_ids.length === 1,
    JSON.stringify(replayed.rows[0]),
  );

  // B links the SAME hash — must resolve to the same device_fingerprints row.
  await admin.query('select public.fn_link_device_fingerprint($1, $2)', [B, hash]);
  const bRow = await admin.query('select device_fingerprint_ids from public.users where id = $1', [
    B,
  ]);
  log(
    'a second user linking the same raw hash shares the same fingerprint id',
    bRow.rows[0].device_fingerprint_ids[0] === first.rows[0].device_fingerprint_ids[0],
    `A=${JSON.stringify(first.rows[0].device_fingerprint_ids)} B=${JSON.stringify(bRow.rows[0].device_fingerprint_ids)}`,
  );

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
  await deleteFingerprint(admin, hash);
}

// =============================================================================
// Test 2: top-up velocity cap — new+unverified capped; a Tier-1 account
// and an aged-out (backdated created_at) unverified account both bypass
// it, matching the two-dimensional (age OR verification) design.
// =============================================================================

async function testTopupVelocityCap(admin) {
  const capRow = await admin.query(
    "select value from public.pricing_config where key = 'new_account_daily_topup_cap_kobo'",
  );
  const cap = Number(capRow.rows[0].value);

  const A = await createTestUser(admin); // fresh, kyc_tier 0 — subject to the cap
  const underCap = await admin.query('select public.fn_buy_credit($1, $2, $3) as id', [
    A,
    Math.floor(cap / 2),
    'flutterwave',
  ]);
  log('a single under-cap topup succeeds', !!underCap.rows[0].id);

  let overCapRejected = false;
  let overCapMessage = '';
  try {
    // Same account, same 24h window — combined with the first call this
    // exceeds the cap.
    await admin.query('select public.fn_buy_credit($1, $2, $3) as id', [A, cap, 'flutterwave']);
  } catch (e) {
    overCapRejected = true;
    overCapMessage = e.message;
  }
  log(
    'a second topup pushing the 24h total over the cap is rejected',
    overCapRejected && overCapMessage.includes('daily_topup_limit_exceeded'),
    overCapMessage,
  );

  const B = await createTestUser(admin);
  await admin.query('update public.users set kyc_tier = 1 where id = $1', [B]);
  const tier1Over = await admin.query('select public.fn_buy_credit($1, $2, $3) as id', [
    B,
    cap * 2,
    'flutterwave',
  ]);
  log(
    'a Tier-1 verified account is not subject to the new-account cap, even for the same amount',
    !!tier1Over.rows[0].id,
  );

  const C = await createTestUser(admin);
  const ageDaysRow = await admin.query(
    "select value from public.pricing_config where key = 'new_account_age_days'",
  );
  const ageDays = Number(ageDaysRow.rows[0].value);
  await admin.query(
    `update public.users set created_at = now() - make_interval(days => $2 + 1) where id = $1`,
    [C, ageDays],
  );
  const agedOver = await admin.query('select public.fn_buy_credit($1, $2, $3) as id', [
    C,
    cap * 2,
    'flutterwave',
  ]);
  log(
    'an unverified but no-longer-new account is not subject to the cap either',
    !!agedOver.rows[0].id,
  );

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
  await deleteTestUser(admin, C);
}

// =============================================================================
// Test 3: collusion detection — shared-fingerprint true positive, and
// re-running the job doesn't duplicate the signal.
// =============================================================================

async function testCollusionSharedFingerprint(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const hash = crypto.randomBytes(32).toString('hex');
  await admin.query('select public.fn_link_device_fingerprint($1, $2)', [A, hash]);
  await admin.query('select public.fn_link_device_fingerprint($1, $2)', [B, hash]);

  await fundWallet(admin, A, 'topup_credit', 100);
  const threadId = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]))
    .rows[0].id;
  await sendMessages(admin, threadId, A, 1);

  const inserted = await admin.query('select public.fn_run_collusion_detection() as n');
  log(
    'collusion job inserts at least one signal for the shared-fingerprint pair',
    Number(inserted.rows[0].n) >= 1,
    `n=${inserted.rows[0].n}`,
  );

  const signal = await admin.query(
    `select severity, metadata from public.fraud_signals
     where signal_type = 'shared_device_fingerprint'
       and ((user_id = $1 and related_user_id = $2) or (user_id = $2 and related_user_id = $1))`,
    [A, B],
  );
  log(
    'the signal is high severity and carries the shared fingerprint id',
    signal.rows[0]?.severity === 'high' && !!signal.rows[0]?.metadata?.shared_fingerprint_id,
    JSON.stringify(signal.rows[0]),
  );

  const rerun = await admin.query('select public.fn_run_collusion_detection() as n');
  const recount = await admin.query(
    `select count(*)::int as c from public.fraud_signals
     where signal_type = 'shared_device_fingerprint'
       and ((user_id = $1 and related_user_id = $2) or (user_id = $2 and related_user_id = $1))`,
    [A, B],
  );
  log(
    're-running the job does not insert a duplicate signal for the same pair',
    recount.rows[0].c === 1,
    `after rerun (inserted ${rerun.rows[0].n} new), total rows for this pair = ${recount.rows[0].c}`,
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
  await deleteFingerprint(admin, hash);
}

// =============================================================================
// Test 4: collusion detection — concentrated pairing true positive (one
// payer, overwhelmingly one payee, above the message floor).
// =============================================================================

async function testCollusionConcentratedPairing(admin) {
  const floorRow = await admin.query(
    "select value from public.pricing_config where key = 'collusion_concentration_min_messages'",
  );
  const floor = Number(floorRow.rows[0].value);

  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await fundWallet(admin, A, 'topup_credit', (floor + 5) * 2); // 2 credits/short message
  const threadId = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]))
    .rows[0].id;
  await sendMessages(admin, threadId, A, floor + 1, 'ok'); // all to the same payee -> 100% share

  await admin.query('select public.fn_run_collusion_detection() as n');

  const signal = await admin.query(
    `select severity, metadata from public.fraud_signals
     where signal_type = 'concentrated_pairing' and user_id = $1 and related_user_id = $2`,
    [A, B],
  );
  log(
    'a payer sending everything to one payee above the floor gets a medium concentrated_pairing signal',
    signal.rows[0]?.severity === 'medium' && signal.rows[0]?.metadata?.share_bps === 10000,
    JSON.stringify(signal.rows[0]),
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 5: false-positive check — a normal pair, no shared fingerprint,
// activity well under the concentration floor, must NOT get flagged by
// either signal type. This is the check that matters as much as the true
// positives: a fraud system real users can trust not to flag them.
// =============================================================================

async function testNoFalsePositiveOnNormalActivity(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await fundWallet(admin, A, 'topup_credit', 20);
  const threadId = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]))
    .rows[0].id;
  await sendMessages(admin, threadId, A, 2, 'hey, how are you?');

  await admin.query('select public.fn_run_collusion_detection() as n');

  const signals = await admin.query(
    `select signal_type from public.fraud_signals
     where (user_id = $1 and related_user_id = $2) or (user_id = $2 and related_user_id = $1)`,
    [A, B],
  );
  log(
    'a normal, low-volume, no-shared-fingerprint pair is not flagged by either signal type',
    signals.rows.length === 0,
    JSON.stringify(signals.rows),
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 6: fn_transfer_credit's new recipient KYC gate.
// =============================================================================

async function testTransferCreditKycGate(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin); // kyc_tier 0
  await fundWallet(admin, A, 'topup_credit', 100);

  let rejected = false;
  let message = '';
  try {
    await admin.query('select public.fn_transfer_credit($1, $2, $3, $4)', [A, B, 10, null]);
  } catch (e) {
    rejected = true;
    message = e.message;
  }
  log(
    'transferring to a Tier-0 recipient is rejected with recipient_kyc_required',
    rejected && message.includes('recipient_kyc_required'),
    message,
  );

  await admin.query('update public.users set kyc_tier = 1 where id = $1', [B]);
  const ok = await admin.query('select public.fn_transfer_credit($1, $2, $3, $4) as id', [
    A,
    B,
    10,
    null,
  ]);
  log('the same transfer succeeds once the recipient is Tier-1 verified', !!ok.rows[0].id);

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 7: escrow-release rate limit, per thread (docs/06-SECURITY-FRAUD-
// LOOPHOLES.md §6) — a burst of messages past the per-minute cap must
// still all SEND (the payer is charged for every one, matching this
// project's own "never fail the message" design), but only cap-worth of
// escrows actually RELEASE; the rest stay pending for a later call to
// pick up once the window moves on. Session 13's own manual verification
// against this exact scenario is what this codifies.
// =============================================================================

async function testEscrowReleaseRateLimitPerThread(admin) {
  const capRow = await admin.query(
    "select value from public.pricing_config where key = 'escrow_release_messages_per_minute_cap'",
  );
  const cap = Number(capRow.rows[0].value);

  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await fundWallet(admin, A, 'topup_credit', (cap + 5) * 2);
  const threadId = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]))
    .rows[0].id;

  // cap+3 messages from the fixed payer A, then one reply from B to
  // trigger a single release pass over everything still pending.
  await sendMessages(admin, threadId, A, cap + 3, 'msg');
  await sendMessages(admin, threadId, B, 1, 'ok');

  const counts = await admin.query(
    `select status, count(*)::int as n from public.escrows where thread_id = $1 group by status`,
    [threadId],
  );
  const released = counts.rows.find((r) => r.status === 'released')?.n ?? 0;
  const pending = counts.rows.find((r) => r.status === 'pending')?.n ?? 0;
  const totalSent = cap + 4; // (cap + 3) from A, 1 from B
  log(
    `a burst past the per-minute cap (${cap}) releases exactly the cap, the rest stay pending`,
    released === cap && pending === totalSent - cap,
    `released=${released} pending=${pending} cap=${cap}`,
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 8: escrow-release rate limit, per payee, GLOBALLY across threads —
// distinct from the per-thread cap above: a farmer running two
// simultaneous 1:1 "conversations" to the same payee must still be
// caught in aggregate. Temporarily lowers the real cap (same
// flip-and-restore-in-finally pattern group-chat-functions.test.js
// already uses for group_chat_enabled) rather than sending 100+ real
// messages to exercise the production default.
// =============================================================================

async function testEscrowReleaseRateLimitPerPayeeAcrossThreads(admin) {
  const key = 'escrow_release_earnings_per_hour_cap';
  const original = (
    await admin.query('select value from public.pricing_config where key = $1', [key])
  ).rows[0].value;

  try {
    await admin.query('update public.pricing_config set value = 3 where key = $1', [key]);

    const A1 = await createTestUser(admin);
    const A2 = await createTestUser(admin);
    const B = await createTestUser(admin);
    await fundWallet(admin, A1, 'topup_credit', 20);
    await fundWallet(admin, A2, 'topup_credit', 20);

    const thread1 = (await admin.query('select public.fn_start_thread($1, $2) as id', [A1, B]))
      .rows[0].id;
    const thread2 = (await admin.query('select public.fn_start_thread($1, $2) as id', [A2, B]))
      .rows[0].id;

    // 3 messages + 1 reply in each thread = up to 8 releasable escrows
    // total for the SAME payee B, well past the lowered cap of 3.
    await sendMessages(admin, thread1, A1, 3, 'hey');
    await sendMessages(admin, thread1, B, 1, 'yo');
    await sendMessages(admin, thread2, A2, 3, 'hey');
    await sendMessages(admin, thread2, B, 1, 'yo');

    const released = (
      await admin.query(
        `select count(*)::int as n from public.escrows where payee_id = $1 and status = 'released'`,
        [B],
      )
    ).rows[0].n;
    log(
      "the per-hour cap applies to B's total releases across BOTH threads, not each thread independently",
      released === 3,
      `released=${released} (lowered cap=3)`,
    );

    await deleteTestThread(admin, thread1);
    await deleteTestThread(admin, thread2);
    await deleteTestUser(admin, A1);
    await deleteTestUser(admin, A2);
    await deleteTestUser(admin, B);
  } finally {
    await admin.query('update public.pricing_config set value = $2 where key = $1', [
      key,
      original,
    ]);
  }
}

// =============================================================================
// Test 9: duplicate-content detection — B's near-identical replies get
// skipped (stay pending) with exactly one fraud_signals row, not one per
// repeat. Also the real bug this session's manual verification caught:
// A's own (textually similar) OPENING message must still release fine —
// the check is scoped to the payee's own message history, never the
// payer's, since the payer isn't the one being evaluated for farming.
// =============================================================================

async function testDuplicateContentFlaggedButPayerUnaffected(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await fundWallet(admin, A, 'topup_credit', 100);
  const threadId = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]))
    .rows[0].id;

  await admin.query('select public.fn_send_message($1, $2, $3)', [
    threadId,
    A,
    'hi there how is your day going',
  ]);
  for (let i = 0; i < 5; i++) {
    await admin.query('select public.fn_send_message($1, $2, $3)', [
      threadId,
      B,
      'hi there how is your day going today',
    ]);
  }

  const aMessage = await admin.query(
    `select e.status from public.escrows e join public.messages m on m.id = e.message_id
     where e.thread_id = $1 and m.sender_id = $2`,
    [threadId, A],
  );
  log(
    "the payer A's own (textually similar) opening message still releases — the check never applies to the payer",
    aMessage.rows[0]?.status === 'released',
    JSON.stringify(aMessage.rows[0]),
  );

  const bCounts = await admin.query(
    `select e.status, count(*)::int as n from public.escrows e join public.messages m on m.id = e.message_id
     where e.thread_id = $1 and m.sender_id = $2 group by e.status`,
    [threadId, B],
  );
  const bPending = bCounts.rows.find((r) => r.status === 'pending')?.n ?? 0;
  log(
    "B's near-identical repeats mostly stay pending (only the first, with nothing yet to compare against, releases)",
    bPending === 4,
    JSON.stringify(bCounts.rows),
  );

  const signals = await admin.query(
    `select count(*)::int as n from public.fraud_signals where user_id = $1 and signal_type = 'duplicate_content'`,
    [B],
  );
  log(
    'exactly one duplicate_content signal, not one per repeated message',
    signals.rows[0].n === 1,
    `n=${signals.rows[0].n}`,
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 10: false-positive check — genuinely varied replies from B, across
// several exchanges, must ALL release normally. A duplicate-content
// system worth trusting has to prove it leaves a real, varied
// conversation alone, not just that it catches repetition.
// =============================================================================

async function testNoDuplicateFalsePositiveOnVariedConversation(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  await fundWallet(admin, A, 'topup_credit', 100);
  const threadId = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]))
    .rows[0].id;

  const replies = [
    'how was your weekend',
    'did you watch the match last night',
    'what are you cooking today',
    'I finally finished that book',
  ];
  for (const reply of replies) {
    await admin.query('select public.fn_send_message($1, $2, $3)', [threadId, A, `so, ${reply}?`]);
    await admin.query('select public.fn_send_message($1, $2, $3)', [threadId, B, reply]);
  }

  const counts = await admin.query(
    `select status, count(*)::int as n from public.escrows where thread_id = $1 group by status`,
    [threadId],
  );
  log(
    'a genuinely varied back-and-forth releases every escrow, none flagged as duplicate',
    counts.rows.length === 1 &&
      counts.rows[0].status === 'released' &&
      counts.rows[0].n === replies.length * 2,
    JSON.stringify(counts.rows),
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Settlement-aware auto-withdrawal holds (docs/06-SECURITY-FRAUD-LOOPHOLES.md
// §3/§4) — fn_is_withdrawal_trusted and fn_run_auto_withdraw_sweep's new
// trust gate.
// =============================================================================

async function testAutoSweepTrustedPayeeSweepsAtNormalThreshold(admin) {
  const A = await createAgedUser(admin, 60); // well past new_account_age_days (30), clean history
  const { bankAccountId } = await setupWithdrawableWallet(admin, A, 100000, 30); // 30h old, past the 24h threshold

  const trusted = await admin.query('select public.fn_is_withdrawal_trusted($1) as t', [A]);
  log(
    'an aged, clean, Tier-1 payee is trusted',
    trusted.rows[0].t === true,
    `trusted=${trusted.rows[0].t}`,
  );

  await admin.query('select public.fn_run_auto_withdraw_sweep()');

  const wallet = await admin.query(
    `select balance from public.wallets where user_id = $1 and kind = 'withdrawable_cash'`,
    [A],
  );
  log(
    "a trusted payee's money sweeps at the normal 24h threshold",
    Number(wallet.rows[0].balance) === 0,
    `balance=${wallet.rows[0].balance}`,
  );

  void bankAccountId;
  await deleteTestUser(admin, A);
}

async function testAutoSweepUntrustedPayeeHoldsUntilLongerThreshold(admin) {
  const A = await createAgedUser(admin, 5); // fresh — under new_account_age_days (30)
  await setupWithdrawableWallet(admin, A, 100000, 30); // 30h old — past 24h but under 72h

  const trusted = await admin.query('select public.fn_is_withdrawal_trusted($1) as t', [A]);
  log(
    'a fresh (5-day-old) Tier-1 payee is not trusted',
    trusted.rows[0].t === false,
    `trusted=${trusted.rows[0].t}`,
  );

  await admin.query('select public.fn_run_auto_withdraw_sweep()');

  const walletAt30h = await admin.query(
    `select balance from public.wallets where user_id = $1 and kind = 'withdrawable_cash'`,
    [A],
  );
  log(
    "an untrusted payee's money is NOT swept at 30h (needs the longer untrusted threshold)",
    Number(walletAt30h.rows[0].balance) === 100000,
    `balance=${walletAt30h.rows[0].balance}`,
  );

  // Age the same wallet past the untrusted threshold (72h) and re-run.
  await admin.query(
    `update public.wallets set updated_at = now() - interval '80 hours'
     where user_id = $1 and kind = 'withdrawable_cash'`,
    [A],
  );
  await admin.query('select public.fn_run_auto_withdraw_sweep()');

  const walletAt80h = await admin.query(
    `select balance from public.wallets where user_id = $1 and kind = 'withdrawable_cash'`,
    [A],
  );
  log(
    'the same untrusted payee sweeps once past the untrusted (72h) threshold',
    Number(walletAt80h.rows[0].balance) === 0,
    `balance=${walletAt80h.rows[0].balance}`,
  );

  await deleteTestUser(admin, A);
}

async function testAutoSweepHeldIndefinitelyWhileHighSeveritySignalIsRecent(admin) {
  const A = await createAgedUser(admin, 60); // aged, would otherwise be trusted
  await setupWithdrawableWallet(admin, A, 1000, 24 * 10); // 10 days old, past force-sweep (7d), below withdrawal_min_kobo
  await admin.query(
    `insert into public.fraud_signals (user_id, signal_type, severity, metadata) values ($1, 'chargeback', 'high', '{}')`,
    [A],
  );

  const trusted = await admin.query('select public.fn_is_withdrawal_trusted($1) as t', [A]);
  log(
    'a payee with a recent high-severity signal is not trusted despite account age',
    trusted.rows[0].t === false,
    `trusted=${trusted.rows[0].t}`,
  );

  await admin.query('select public.fn_run_auto_withdraw_sweep()');

  const wallet = await admin.query(
    `select balance from public.wallets where user_id = $1 and kind = 'withdrawable_cash'`,
    [A],
  );
  log(
    'flagged money is held, never force-swept, even past the force-sweep window and below the minimum',
    Number(wallet.rows[0].balance) === 1000,
    `balance=${wallet.rows[0].balance}`,
  );

  await deleteTestUser(admin, A);
}

async function testAutoSweepSignalAgingOutOfLookbackUnblocksSweep(admin) {
  const A = await createAgedUser(admin, 60);
  await setupWithdrawableWallet(admin, A, 100000, 30);
  // withdrawal_trust_signal_lookback_days is 90 — a signal from 100 days ago
  // no longer disqualifies.
  await admin.query(
    `insert into public.fraud_signals (user_id, signal_type, severity, metadata, created_at)
     values ($1, 'chargeback', 'high', '{}', now() - interval '100 days')`,
    [A],
  );

  const trusted = await admin.query('select public.fn_is_withdrawal_trusted($1) as t', [A]);
  log(
    'a high-severity signal outside the lookback window no longer disqualifies',
    trusted.rows[0].t === true,
    `trusted=${trusted.rows[0].t}`,
  );

  await admin.query('select public.fn_run_auto_withdraw_sweep()');

  const wallet = await admin.query(
    `select balance from public.wallets where user_id = $1 and kind = 'withdrawable_cash'`,
    [A],
  );
  log(
    'the payee sweeps normally once the disqualifying signal has aged out',
    Number(wallet.rows[0].balance) === 0,
    `balance=${wallet.rows[0].balance}`,
  );

  await deleteTestUser(admin, A);
}

async function testManualWithdrawalUnaffectedByTrustStatus(admin) {
  const A = await createAgedUser(admin, 5); // fresh, untrusted
  const { bankAccountId } = await setupWithdrawableWallet(admin, A, 100000, 1); // only 1h old — wouldn't auto-sweep either way

  const trusted = await admin.query('select public.fn_is_withdrawal_trusted($1) as t', [A]);
  log(
    'setup: this payee is untrusted',
    trusted.rows[0].t === false,
    `trusted=${trusted.rows[0].t}`,
  );

  const manual = await admin.query('select * from public.fn_initiate_withdrawal($1, $2, $3, $4)', [
    A,
    bankAccountId,
    100000,
    true,
  ]);
  log(
    'a manual (user-initiated) withdrawal succeeds regardless of trust status — only auto-sweep timing is gated',
    Number(manual.rows[0].amount_kobo) === 100000,
    JSON.stringify(manual.rows[0]),
  );

  await deleteTestUser(admin, A);
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testLinkDeviceFingerprint(admin);
    await testTopupVelocityCap(admin);
    await testCollusionSharedFingerprint(admin);
    await testCollusionConcentratedPairing(admin);
    await testNoFalsePositiveOnNormalActivity(admin);
    await testTransferCreditKycGate(admin);
    await testEscrowReleaseRateLimitPerThread(admin);
    await testEscrowReleaseRateLimitPerPayeeAcrossThreads(admin);
    await testDuplicateContentFlaggedButPayerUnaffected(admin);
    await testNoDuplicateFalsePositiveOnVariedConversation(admin);
    await testAutoSweepTrustedPayeeSweepsAtNormalThreshold(admin);
    await testAutoSweepUntrustedPayeeHoldsUntilLongerThreshold(admin);
    await testAutoSweepHeldIndefinitelyWhileHighSeveritySignalIsRecent(admin);
    await testAutoSweepSignalAgingOutOfLookbackUnblocksSweep(admin);
    await testManualWithdrawalUnaffectedByTrustStatus(admin);
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
