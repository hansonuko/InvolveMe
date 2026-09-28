#!/usr/bin/env node
// Payer/earner role (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §C1,
// 20260926140000_thread_payer_role.sql) — direct DB-level tests, same
// pattern as chargeback-functions.test.js (plain pg.Client + fn_ calls;
// fn_set_thread_payer has no Edge Function wrapper of its own logic worth
// re-testing at the HTTP layer beyond request validation, which
// set-thread-payer-function.test.js covers separately).
//
// Covers two things this feature actually needed, not just "does it run":
//
//   1. fn_set_thread_payer's policy: self-only appointment, only the
//      current payer may step down, taking over the role (from an active
//      payer OR from null) is instant and ungated — same as stepping down
//      always was (20260927120000_payer_takeover_instant_flip_burst_signal.sql
//      removed the 24h idle gate this used to have; a willing payer must
//      never be made to wait) — and every change is logged to
//      thread_payer_history with the correct old/new values.
//
//   2. The actual bug this build's second review pass found and fixed:
//      fn_release_escrow used to hardcode thread.participant_b as "the
//      payee" in three places. Test "a payer flip correctly routes escrow
//      releases to each escrow's own frozen payee" below is the one that
//      would have failed against the pre-fix function — it specifically
//      exercises a release where the payee is participant_a, which the old
//      hardcoded-to-participant_b code could never get right.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:thread-payer` from the repo root.',
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
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from auth.users where id = $1', [id]); // cascades to public.users
}

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.thread_payer_history where thread_id = $1', [threadId]);
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function walletRow(admin, userId, kind) {
  const r = await admin.query(
    'select id, balance, is_frozen from public.wallets where user_id=$1 and kind=$2',
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

async function backdateLastMessage(admin, threadId, hoursAgo) {
  await admin.query(
    `update public.threads set last_message_at = now() - make_interval(hours => $2) where id = $1`,
    [threadId, hoursAgo],
  );
}

// For the payer_flip_then_burst signal test below — that signal judges
// "was the thread idle before the flip" off the actual `messages.created_at`
// of the last message before the flip, not `threads.last_message_at`
// (which the flip itself doesn't touch), so it needs its own backdate helper.
async function backdateMessage(admin, messageId, hoursAgo) {
  await admin.query(
    `update public.messages set created_at = now() - make_interval(hours => $2) where id = $1`,
    [messageId, hoursAgo],
  );
}

async function fraudSignalsFor(admin, userId, signalType) {
  const r = await admin.query(
    `select user_id, related_user_id, metadata from public.fraud_signals
     where user_id = $1 and signal_type = $2`,
    [userId, signalType],
  );
  return r.rows;
}

async function sendMessage(admin, threadId, senderId, body) {
  const r = await admin.query('select * from public.fn_send_message($1, $2, $3)', [
    threadId,
    senderId,
    body,
  ]);
  return r.rows[0];
}

async function setThreadPayer(admin, threadId, callerId, newPayerId) {
  await admin.query('select public.fn_set_thread_payer($1, $2, $3)', [
    threadId,
    callerId,
    newPayerId,
  ]);
}

async function payerHistory(admin, threadId) {
  const r = await admin.query(
    'select changed_by, old_payer_id, new_payer_id from public.thread_payer_history where thread_id = $1 order by changed_at',
    [threadId],
  );
  return r.rows;
}

async function threadRow(admin, threadId) {
  const r = await admin.query(
    'select payer_id, last_message_at from public.threads where id = $1',
    [threadId],
  );
  return r.rows[0];
}

// ===========================================================================
// Test 1: policy — self-only appointment, current-payer-only stepdown,
// idle gate on takeover (from an active payer AND from null), stepping
// down itself is never gated, and every change lands in the audit table.
// ===========================================================================

async function testSetThreadPayerPolicy(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const C = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;
  await fundTopupCredit(admin, A, 50);
  await fundTopupCredit(admin, B, 50);

  try {
    const initial = await threadRow(admin, threadId);
    log('a new thread defaults payer_id to the initiator (A)', initial.payer_id === A);

    await sendMessage(admin, threadId, A, 'hello'); // sets last_message_at to "now"

    let rejected = false;
    try {
      await setThreadPayer(admin, threadId, B, A);
    } catch (e) {
      rejected = e.message.includes('can_only_appoint_self');
    }
    log('a caller cannot appoint someone else as payer', rejected);

    rejected = false;
    try {
      await setThreadPayer(admin, threadId, C, C);
    } catch (e) {
      rejected = e.message.includes('not_a_participant');
    }
    log('a non-participant cannot touch the payer role', rejected);

    rejected = false;
    try {
      await setThreadPayer(admin, threadId, B, null);
    } catch (e) {
      rejected = e.message.includes('not_current_payer');
    }
    log('only the current payer (A) can step down — B cannot step A down', rejected);

    // The thread is fresh (last_message_at just set to "now" above) — a
    // takeover here is exactly the case the old idle gate used to reject.
    // It must succeed instantly regardless: a willing payer is never made
    // to wait (20260927120000_payer_takeover_instant_flip_burst_signal.sql).
    await setThreadPayer(admin, threadId, B, B);
    let after = await threadRow(admin, threadId);
    log('B can take over from A INSTANTLY even on a fresh, non-idle thread', after.payer_id === B);

    // A (no longer the payer) cannot step down — only the current payer can.
    let rejectedStepdown = false;
    try {
      await setThreadPayer(admin, threadId, A, null);
    } catch (e) {
      rejectedStepdown = e.message.includes('not_current_payer');
    }
    log('A can no longer step down now that B is the payer', rejectedStepdown);

    // B steps down — instant, as always.
    await setThreadPayer(admin, threadId, B, null);
    after = await threadRow(admin, threadId);
    log('B stepping down succeeds immediately', after.payer_id === null);

    // Claiming out of a null payer_id, on a still-fresh thread, is ALSO
    // instant — the old gate deliberately did not exempt this path either,
    // and removing the gate must remove it from both paths equally.
    await setThreadPayer(admin, threadId, B, B);
    after = await threadRow(admin, threadId);
    log(
      'claiming out of a null payer_id is ALSO instant on a non-idle thread (no step-down-then-reclaim penalty)',
      after.payer_id === B,
    );

    // No-op: B is already the payer.
    const historyBefore = await payerHistory(admin, threadId);
    await setThreadPayer(admin, threadId, B, B);
    const historyAfterNoop = await payerHistory(admin, threadId);
    log(
      'appointing yourself when you are already the payer is a silent no-op, not an error or a new history row',
      historyAfterNoop.length === historyBefore.length,
    );

    const history = await payerHistory(admin, threadId);
    log(
      'thread_payer_history recorded exactly the three real transitions (A->B, B->null, null->B)',
      history.length === 3 &&
        history[0].old_payer_id === A &&
        history[0].new_payer_id === B &&
        history[1].old_payer_id === B &&
        history[1].new_payer_id === null &&
        history[2].old_payer_id === null &&
        history[2].new_payer_id === B,
      JSON.stringify(history),
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    await deleteTestUser(admin, C);
  }
}

// ===========================================================================
// Test 2: a thread with payer_id null rejects sends from either side with
// a specific error, not insufficient_credit and not a silent free send.
// ===========================================================================

async function testNoActivePayerBlocksSends(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;
  await fundTopupCredit(admin, A, 50);
  await fundTopupCredit(admin, B, 50);

  try {
    await sendMessage(admin, threadId, A, 'hello');
    await setThreadPayer(admin, threadId, A, null);

    let rejectedA = false;
    try {
      await sendMessage(admin, threadId, A, 'still there?');
    } catch (e) {
      rejectedA = e.message.includes('no_active_payer');
    }
    log('a send from A is rejected with no_active_payer while payer_id is null', rejectedA);

    let rejectedB = false;
    try {
      await sendMessage(admin, threadId, B, 'hello?');
    } catch (e) {
      rejectedB = e.message.includes('no_active_payer');
    }
    log('a send from B is ALSO rejected with no_active_payer — neither side is exempt', rejectedB);
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 3: the actual bug fix. After a payer takeover, a pending escrow
// whose frozen payee is participant_a must release into participant_a's
// wallets — the exact case the old hardcoded-to-participant_b
// fn_release_escrow could never get right. Also proves ledger conservation
// and that each side's balance reflects only the debits it actually paid.
// ===========================================================================

async function testPayerFlipRoutesReleasesToCorrectPayee(admin) {
  const A = await createTestUser(admin); // participant_a, thread initiator
  const B = await createTestUser(admin); // participant_b
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;
  await fundTopupCredit(admin, A, 100);
  await fundTopupCredit(admin, B, 100);

  try {
    // 1) A pays for the first message. B is the payee. Nobody has replied
    //    yet, so this escrow sits pending.
    const msg1 = await sendMessage(admin, threadId, A, 'hello there, how are you');
    log("A's first message escrows normally", msg1.status === 'escrowed');

    const escrow1 = (
      await admin.query(
        'select status, payer_id, payee_id from public.escrows where message_id = $1',
        [msg1.message_id],
      )
    ).rows[0];
    log(
      'escrow1 is pending, frozen as payer=A/payee=B at send time',
      escrow1.status === 'pending' && escrow1.payer_id === A && escrow1.payee_id === B,
      JSON.stringify(escrow1),
    );

    // 2) B takes over paying — instant, no idle requirement (this test
    // isn't about the takeover gate, so it doesn't matter either way; not
    // backdated, unlike before this feature's idle gate was removed).
    await setThreadPayer(admin, threadId, B, B);
    log(
      'B successfully takes over the payer role',
      (await threadRow(admin, threadId)).payer_id === B,
    );

    // 3) B sends the next message. B is now the payer (debited), and B is
    //    also escrow1's own payee — so this send correctly self-releases
    //    escrow1 into B's wallets. A new escrow2 (payer=B, payee=A) is
    //    created and stays pending (A hasn't replied to it yet).
    const bEarningsBefore = await walletRow(admin, B, 'earnings_pending');
    const bCashBefore = await walletRow(admin, B, 'withdrawable_cash');
    const msg2 = await sendMessage(admin, threadId, B, 'I am doing well thanks');
    log("B's message (as the new payer) escrows and debits B", msg2.status === 'escrowed');

    const escrow1After = (
      await admin.query('select status from public.escrows where message_id = $1', [
        msg1.message_id,
      ])
    ).rows[0];
    log(
      'escrow1 released the moment its own payee (B) sent anything',
      escrow1After.status === 'released',
    );

    const bEarningsAfter1 = await walletRow(admin, B, 'earnings_pending');
    const bCashAfter1 = await walletRow(admin, B, 'withdrawable_cash');
    log(
      "B's earnings/cash wallets grew from escrow1's release",
      Number(bCashAfter1.balance) > Number(bCashBefore.balance),
      `before=${bCashBefore.balance} after=${bCashAfter1.balance}`,
    );

    const escrow2 = (
      await admin.query(
        'select status, payer_id, payee_id from public.escrows where message_id = $1',
        [msg2.message_id],
      )
    ).rows[0];
    log(
      "escrow2 is frozen payer=B/payee=A and stays pending (A hasn't replied yet)",
      escrow2.status === 'pending' && escrow2.payer_id === B && escrow2.payee_id === A,
      JSON.stringify(escrow2),
    );

    // 4) THE ACTUAL FIX, PROVEN: A replies. A is participant_a — the payee
    //    the old hardcoded-to-participant_b fn_release_escrow could never
    //    correctly credit. This release must land in A's wallets, and must
    //    NOT touch B's wallets at all.
    const aEarningsBefore = await walletRow(admin, A, 'earnings_pending');
    const aCashBefore = await walletRow(admin, A, 'withdrawable_cash');
    const bCashBefore2 = await walletRow(admin, B, 'withdrawable_cash');

    const msg3 = await sendMessage(admin, threadId, A, 'thanks, you too');
    log(
      "A's reply also escrows (B is still the payer, regardless of who sends)",
      msg3.status === 'escrowed',
    );

    const escrow2After = (
      await admin.query('select status from public.escrows where message_id = $1', [
        msg2.message_id,
      ])
    ).rows[0];
    const escrow3 = (
      await admin.query(
        'select status, payer_id, payee_id from public.escrows where message_id = $1',
        [msg3.message_id],
      )
    ).rows[0];
    log("escrow2 (payee=A) released by A's reply", escrow2After.status === 'released');
    log(
      "escrow3 (A's own message, payee=A too, since B pays regardless of sender) self-released in the same call",
      escrow3.payer_id === B && escrow3.payee_id === A && escrow3.status === 'released',
      JSON.stringify(escrow3),
    );

    const aCashAfter = await walletRow(admin, A, 'withdrawable_cash');
    const bCashAfter2 = await walletRow(admin, B, 'withdrawable_cash');
    log(
      "A's withdrawable_cash grew from escrow2+escrow3 — the exact release the old hardcoded code would have misdirected to B",
      Number(aCashAfter.balance) > Number(aCashBefore.balance),
      `before=${aCashBefore.balance} after=${aCashAfter.balance}`,
    );
    log(
      "B's withdrawable_cash was NOT touched by A's reply release (would have been, under the old bug)",
      Number(bCashAfter2.balance) === Number(bCashBefore2.balance),
      `before=${bCashBefore2.balance} after=${bCashAfter2.balance}`,
    );

    // 5) Ledger conservation across every wallet touched in this scenario.
    for (const [label, userId, kind] of [
      ['A topup_credit', A, 'topup_credit'],
      ['A earnings_pending', A, 'earnings_pending'],
      ['A withdrawable_cash', A, 'withdrawable_cash'],
      ['B topup_credit', B, 'topup_credit'],
      ['B earnings_pending', B, 'earnings_pending'],
      ['B withdrawable_cash', B, 'withdrawable_cash'],
    ]) {
      const w = await walletRow(admin, userId, kind);
      const sum = await ledgerSum(admin, w.id);
      log(
        `ledger conservation holds for ${label}`,
        sum === Number(w.balance),
        `sum=${sum} balance=${w.balance}`,
      );
    }

    // 6) Each side was debited only for what it actually paid: A paid for
    //    message1 only (100 credits); B paid for message2 and message3.
    const aTopup = await walletRow(admin, A, 'topup_credit');
    const bTopup = await walletRow(admin, B, 'topup_credit');
    log(
      "A's topup_credit was debited exactly once (message1) despite three messages in the thread",
      Number(aTopup.balance) === 100 - Number(msg1.credits_charged),
      `balance=${aTopup.balance} expected=${100 - Number(msg1.credits_charged)}`,
    );
    log(
      "B's topup_credit was debited for both its messages (message2 + message3), not message1",
      Number(bTopup.balance) === 100 - Number(msg2.credits_charged) - Number(msg3.credits_charged),
      `balance=${bTopup.balance}`,
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 4: concurrency — two simultaneous "B claims payer" calls must not
// both succeed as real transitions. fn_set_thread_payer's `for update` lock on the thread row
// serializes them; the loser should see itself as already-the-payer (a
// no-op) rather than racing a second real change through.
// ===========================================================================

async function testConcurrentClaimCannotDoubleLog(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;
  await fundTopupCredit(admin, A, 50);

  try {
    await sendMessage(admin, threadId, A, 'hello');

    const client1 = newClient();
    const client2 = newClient();
    await client1.connect();
    await client2.connect();

    const results = await Promise.allSettled([
      client1.query('select public.fn_set_thread_payer($1, $2, $3)', [threadId, B, B]),
      client2.query('select public.fn_set_thread_payer($1, $2, $3)', [threadId, B, B]),
    ]);

    await client1.end();
    await client2.end();

    const bothSucceeded = results.every((r) => r.status === 'fulfilled');
    log(
      'both concurrent claim calls complete without error (row lock serializes, no deadlock)',
      bothSucceeded,
    );

    const after = await threadRow(admin, threadId);
    log('the thread ends up with exactly one consistent payer (B)', after.payer_id === B);

    const history = await payerHistory(admin, threadId);
    log(
      'exactly one real transition was logged despite two concurrent calls (the second saw itself as already-payer)',
      history.length === 1 && history[0].old_payer_id === A && history[0].new_payer_id === B,
      JSON.stringify(history),
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 5: payer_flip_then_burst fraud signal (docs/18 §C1's own scoped-but-
// never-built follow-up, now built as part of removing the blocking idle
// gate on takeover — 20260927120000_payer_takeover_instant_flip_burst_
// signal.sql). Proves the signal actually fires on the pattern it's meant
// to catch (an idle-boundary flip immediately followed by a paid-message
// burst from the new payer), and does NOT fire on a flip with no burst
// after it — same "prove it, don't assume it generalizes" rigor docs/18
// §C1 itself calls for.
// ===========================================================================

async function testPayerFlipThenBurstSignal(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;
  await fundTopupCredit(admin, A, 50);
  await fundTopupCredit(admin, B, 50);

  const C = await createTestUser(admin); // second, unrelated pair — the negative control
  const D = await createTestUser(admin);
  const controlThreadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [C, D]);
  const controlThreadId = controlThreadRes.rows[0].id;
  await fundTopupCredit(admin, C, 50);
  await fundTopupCredit(admin, D, 50);

  try {
    // Positive case: A's message goes stale (30h — past the 24h idle
    // threshold), B takes over, then B sends a burst of 5 paid messages
    // within the 1h window.
    const msg1 = await sendMessage(admin, threadId, A, 'hello');
    await backdateMessage(admin, msg1.message_id, 30);
    await setThreadPayer(admin, threadId, B, B);
    for (let i = 0; i < 5; i++) {
      await sendMessage(admin, threadId, B, `burst message ${i}`);
    }

    // Negative control: same idle-boundary flip, but NO burst afterward —
    // must not fire.
    const controlMsg1 = await sendMessage(admin, controlThreadId, C, 'hello');
    await backdateMessage(admin, controlMsg1.message_id, 30);
    await setThreadPayer(admin, controlThreadId, D, D);
    await sendMessage(admin, controlThreadId, D, 'just one reply, no burst');

    const signalCount = (await admin.query('select public.fn_run_collusion_detection() as n'))
      .rows[0].n;
    log('fn_run_collusion_detection runs without error and returns a count', signalCount >= 1);

    const positiveSignals = await fraudSignalsFor(admin, B, 'payer_flip_then_burst');
    log(
      'the idle-boundary flip + 5-message burst DOES fire payer_flip_then_burst, flagging the new payer against the other participant',
      positiveSignals.length === 1 &&
        positiveSignals[0].related_user_id === A &&
        positiveSignals[0].metadata.thread_id === threadId &&
        positiveSignals[0].metadata.burst_message_count >= 5,
      JSON.stringify(positiveSignals),
    );

    const negativeSignals = await fraudSignalsFor(admin, D, 'payer_flip_then_burst');
    log(
      'the same idle-boundary flip WITHOUT a burst afterward does NOT fire the signal',
      negativeSignals.length === 0,
      JSON.stringify(negativeSignals),
    );

    // Re-running the nightly job must not double-insert for the same flip.
    await admin.query('select public.fn_run_collusion_detection()');
    const positiveSignalsAfterRerun = await fraudSignalsFor(admin, B, 'payer_flip_then_burst');
    log(
      're-running the detection job does not duplicate the signal for the same flip event',
      positiveSignalsAfterRerun.length === 1,
    );
  } finally {
    await admin.query('delete from public.fraud_signals where user_id in ($1, $2, $3, $4)', [
      A,
      B,
      C,
      D,
    ]);
    await deleteTestThread(admin, threadId);
    await deleteTestThread(admin, controlThreadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    await deleteTestUser(admin, C);
    await deleteTestUser(admin, D);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testSetThreadPayerPolicy(admin);
    await testNoActivePayerBlocksSends(admin);
    await testPayerFlipRoutesReleasesToCorrectPayee(admin);
    await testPayerFlipThenBurstSignal(admin);
    await testConcurrentClaimCannotDoubleLog(admin);
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
