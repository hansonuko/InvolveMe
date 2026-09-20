#!/usr/bin/env node
// Phase 2 batch 1 — end-to-end test of the send-message Edge Function.
// See README.md for why this runs the function via a bare `deno run`
// instead of `supabase functions serve` (Docker unavailable in this dev
// environment) and what that trade-off means.
//
// Unlike supabase/tests/wallet-functions.test.js (which calls
// fn_send_message directly), this suite goes through the real HTTP
// function: real JWTs, real Authorization header parsing, real error
// mapping — the actual code path the mobile app will use.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  SUPABASE_JWT_SECRET: JWT_SECRET,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

// index.ts calls Deno.serve(handler) with no explicit port, deliberately —
// its call signature must stay exactly what Supabase's hosted edge runtime
// expects, so the test targets Deno's real default (8000) instead of
// parameterizing the function itself.
const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'send-message', 'index.ts');

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

// =============================================================================
// Minimal HS256 JWT minting — no external JWT library needed (CLAUDE.md
// "stay lite"). Matches the claim shape GoTrue issues: sub, role, aud, exp,
// iat. Signed with the project's own JWT secret, so it verifies exactly
// like a real session token would against auth.getUser().
// =============================================================================

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function mintAccessToken(userId) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    exp: now + 3600,
    iat: now,
    sub: userId,
    role: 'authenticated',
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

// =============================================================================
// Test user lifecycle via the Admin API — per docs/00-SESSION-HANDOFF.md's
// guidance for this batch, rather than raw SQL inserts into auth.users, so
// user creation goes through GoTrue's real invariants same as a real signup.
// =============================================================================

async function createTestUser() {
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ phone, phone_confirm: true }),
  });
  if (!res.ok) {
    throw new Error(`createTestUser failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.id;
}

// Deletion goes through raw SQL, not the Admin API — a wallet with any
// ledger_entries against it (which every funded test wallet here has)
// can't cascade-delete through auth.users, because ledger_entries is
// deliberately append-only (a `ledger_entries_no_delete` trigger blocks
// it, per CLAUDE.md rule #4). The Admin API's DELETE just issues
// `delete from auth.users` under the hood and hits that FK violation with
// a 500 — same dependency-order requirement wallet-functions.test.js's
// deleteTestUser already established; mirrored here rather than
// reinvented, now that this suite has real ledger activity to clean up.
async function deleteTestUser(admin, id) {
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id = $1
     )`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from public.withdrawals where user_id = $1', [id]);
  await admin.query('delete from public.bank_accounts where user_id = $1', [id]);
  await admin.query('delete from public.topups where user_id = $1', [id]);
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

// A thread's messages/escrows reference both participants and aren't
// ON DELETE CASCADE from users (see docs/00-SESSION-HANDOFF.md), so — same
// as wallet-functions.test.js — a thread must be torn down as a unit
// before either participant is deleted.
async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
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

async function pricingValue(admin, key) {
  const r = await admin.query('select value from public.pricing_config where key = $1', [key]);
  return Number(r.rows[0].value);
}

function wordMessage(n) {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
}

async function callSendMessage(token, body) {
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Any response (even a 4xx from our own handler) means the Deno HTTP
      // server is up and our code is running.
      await fetch(`${FUNCTION_URL}/`, { method: 'POST', body: '{}' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('send-message function did not come up in time');
}

// =============================================================================
// Test 1 (happy path, matches the exit criteria in docs/00-SESSION-HANDOFF.md):
// two real users hold a full paid exchange through the actual HTTP function —
// A opens a thread with a 30-word message, B replies with 60 words, both
// escrows release, A is debited 6 credits total, B's earnings convert to
// withdrawable_cash, platform earns its cut. Verified against the real DB,
// not just the function's own response.
// =============================================================================

async function testFullPaidExchange(admin) {
  const unitKobo = await pricingValue(admin, 'credit_unit_kobo');
  const takeBps = await pricingValue(admin, 'platform_earning_take_bps');

  const A = await createTestUser();
  const B = await createTestUser();
  const tokenA = mintAccessToken(A);
  const tokenB = mintAccessToken(B);

  const aWallet = await walletRow(admin, A, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 20, 'manual_adjustment')`,
    [aWallet.id],
  );

  // Snapshotted before either message sends, not reset to zero afterward —
  // the platform wallets are a shared singleton, not this test's own
  // fixture, so the real assertion has to be about what THIS test added
  // (the delta), never the wallet's absolute post-test balance.
  const platformRevenueBefore = Number(
    (
      await admin.query(
        "select balance from public.wallets where kind='platform_revenue_earnings_cut' and user_id is null",
      )
    ).rows[0].balance,
  );
  const platformReserveBefore = Number(
    (
      await admin.query(
        "select balance from public.wallets where kind='platform_reserve_earnings_cut' and user_id is null",
      )
    ).rows[0].balance,
  );

  // A opens the thread with a 30-word message: 1 block, base 2 credits.
  const first = await callSendMessage(tokenA, { recipient_id: B, body: wordMessage(30) });
  log(
    'A can open a new thread via recipient_id (HTTP 200)',
    first.status === 200,
    JSON.stringify(first.json),
  );
  log(
    'first send charges exactly 2 credits for a 30-word message',
    first.json?.credits_charged === 2 && first.json?.word_count === 30,
    JSON.stringify(first.json),
  );
  log(
    'response returns a thread_id for the client to continue with',
    typeof first.json?.thread_id === 'string',
  );

  const threadId = first.json.thread_id;
  log(
    "A's balance_after reflects the debit (20 - 2 = 18)",
    Number(first.json?.payer_balance_after) === 18,
    `payer_balance_after=${first.json?.payer_balance_after}`,
  );

  // B replies with a 60-word message using the returned thread_id — this is
  // the case docs/05 warns about: using recipient_id here would create a
  // second, reversed-role thread instead of continuing this one.
  const second = await callSendMessage(tokenB, { thread_id: threadId, body: wordMessage(60) });
  log('B can reply using thread_id (HTTP 200)', second.status === 200, JSON.stringify(second.json));
  log(
    'reply charges 4 more credits, still debited from A (the fixed payer)',
    second.json?.credits_charged === 4 && Number(second.json?.payer_balance_after) === 14,
    `credits_charged=${second.json?.credits_charged} payer_balance_after=${second.json?.payer_balance_after}`,
  );

  const aWalletAfter = await walletRow(admin, A, 'topup_credit');
  log(
    'A is debited 6 credits total across both messages (20 -> 14)',
    Number(aWalletAfter.balance) === 14,
    `balance=${aWalletAfter.balance}`,
  );

  // Expected payee split per docs/03-ECONOMY-LEDGER.md §5's rounding rule:
  // escrow 1 (2cr): platform_cut = round(2 * take_bps/10000), escrow 2 (4cr) likewise.
  const cut1 = Math.round((2 * takeBps) / 10000);
  const cut2 = Math.round((4 * takeBps) / 10000);
  const payeeCredits = 2 - cut1 + (4 - cut2);
  const expectedCashKobo = payeeCredits * unitKobo;

  const bCash = await walletRow(admin, B, 'withdrawable_cash');
  log(
    "B's earnings converted immediately to withdrawable_cash",
    Number(bCash.balance) === expectedCashKobo,
    `expected=${expectedCashKobo} actual=${bCash.balance}`,
  );

  const bEarningsPending = await walletRow(admin, B, 'earnings_pending');
  log(
    "B's earnings_pending nets back to zero after auto-conversion",
    Number(bEarningsPending.balance) === 0,
    `balance=${bEarningsPending.balance}`,
  );

  // The full cut now splits between the spendable revenue wallet and the
  // reserve wallet (platform_reserve_bps, docs/06-SECURITY-FRAUD-LOOPHOLES.md
  // §3) — the two together must still sum to the full cut; that's the
  // conservation property under test, not which wallet holds which slice.
  const platformWallet = await admin.query(
    "select balance from public.wallets where kind='platform_revenue_earnings_cut' and user_id is null",
  );
  const platformReserveWallet = await admin.query(
    "select balance from public.wallets where kind='platform_reserve_earnings_cut' and user_id is null",
  );
  const platformRevenueDelta = Number(platformWallet.rows[0].balance) - platformRevenueBefore;
  const platformReserveDelta =
    Number(platformReserveWallet.rows[0].balance) - platformReserveBefore;
  const platformTotalDelta = platformRevenueDelta + platformReserveDelta;
  log(
    'platform earns its cut across both releases (revenue + reserve combined)',
    platformTotalDelta === cut1 + cut2,
    `expected=${cut1 + cut2} actual=${platformTotalDelta} (revenue_delta=${platformRevenueDelta} reserve_delta=${platformReserveDelta})`,
  );

  const msgs = await admin.query(
    'select status from public.messages where thread_id = $1 order by created_at',
    [threadId],
  );
  log(
    'both messages end up released in the DB (escrow release fired for both)',
    msgs.rows.length === 2 && msgs.rows.every((r) => r.status === 'released'),
    JSON.stringify(msgs.rows),
  );

  // Ledger conservation across every wallet this exchange touched.
  let allReconciled = true;
  const details = [];
  for (const [userId, kind] of [
    [A, 'topup_credit'],
    [B, 'earnings_pending'],
    [B, 'withdrawable_cash'],
  ]) {
    const w = await walletRow(admin, userId, kind);
    const sum = await ledgerSum(admin, w.id);
    const ok = sum === Number(w.balance);
    if (!ok) allReconciled = false;
    details.push({ userId, kind, balance: w.balance, sum, ok });
  }
  for (const kind of ['platform_revenue_earnings_cut', 'platform_reserve_earnings_cut']) {
    const w = (
      await admin.query(
        'select id, balance from public.wallets where kind=$1 and user_id is null',
        [kind],
      )
    ).rows[0];
    const sum = await ledgerSum(admin, w.id);
    const ok = sum === Number(w.balance);
    if (!ok) allReconciled = false;
    details.push({ kind, balance: w.balance, sum, ok });
  }
  log(
    'ledger conservation holds on every wallet touched',
    allReconciled,
    JSON.stringify(details.filter((d) => !d.ok)),
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 2: error mapping — auth, validation, and the insufficient_credit
// shape the docs specifically call out (docs/05 §1's 402 example).
// =============================================================================

async function testErrorMapping(admin) {
  const A = await createTestUser();
  const B = await createTestUser();
  const tokenA = mintAccessToken(A);

  const noAuth = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: B, body: 'hi' }),
  });
  log(
    'missing Authorization header is rejected with 401',
    noAuth.status === 401,
    `status=${noAuth.status}`,
  );

  const badToken = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-real-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: B, body: 'hi' }),
  });
  log('garbage token is rejected with 401', badToken.status === 401, `status=${badToken.status}`);

  const empty = await callSendMessage(tokenA, { recipient_id: B, body: '   ' });
  log(
    'empty/whitespace-only body -> 400 empty_message',
    empty.status === 400 && empty.json?.error === 'empty_message',
    JSON.stringify(empty.json),
  );

  const noTarget = await callSendMessage(tokenA, { body: 'hi' });
  log(
    'neither thread_id nor recipient_id -> 400 invalid_request',
    noTarget.status === 400 && noTarget.json?.error === 'invalid_request',
    JSON.stringify(noTarget.json),
  );

  const self = await callSendMessage(tokenA, { recipient_id: A, body: 'hi' });
  log(
    'recipient_id equal to caller -> 400 invalid_request',
    self.status === 400 && self.json?.error === 'invalid_request',
    JSON.stringify(self.json),
  );

  const fakeRecipient = await callSendMessage(tokenA, {
    recipient_id: crypto.randomUUID(),
    body: 'hi',
  });
  log(
    'nonexistent recipient_id -> 404 recipient_not_found',
    fakeRecipient.status === 404 && fakeRecipient.json?.error === 'recipient_not_found',
    JSON.stringify(fakeRecipient.json),
  );

  const tooLong = await callSendMessage(tokenA, { recipient_id: B, body: wordMessage(501) });
  log(
    '501-word message -> 400 message_too_long',
    tooLong.status === 400 && tooLong.json?.error === 'message_too_long',
    JSON.stringify(tooLong.json),
  );

  // A has zero credits (never funded in this test) — insufficient_credit,
  // with the structured shape docs/05 §1 documents for the 402 case.
  const broke = await callSendMessage(tokenA, { recipient_id: B, body: 'hi there' });
  log(
    'sending with zero balance -> 402 insufficient_credit with credits_required/available',
    broke.status === 402 &&
      broke.json?.error === 'insufficient_credit' &&
      broke.json?.credits_required === 2 &&
      broke.json?.credits_available === 0,
    JSON.stringify(broke.json),
  );

  // The message_too_long case above still creates a real thread via
  // fn_start_thread (find-or-create, its own committed transaction) even
  // though the subsequent fn_send_message call rolls back with no message
  // ever inserted — clean that thread up like every other test does.
  const leftoverThread = await admin.query(
    'select id from public.threads where participant_a = $1 and participant_b = $2',
    [A, B],
  );
  if (leftoverThread.rows[0]) {
    await deleteTestThread(admin, leftoverThread.rows[0].id);
  }

  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 3: client_message_id idempotency (docs/13-OFFLINE-MODE-SCOPING.md) —
// the offline outbox retries a queued send if it never saw a response, and
// that retry must never double-debit or insert a duplicate message. Covers
// both a sequential retry and CLAUDE.md's required concurrency case (two
// simultaneous calls carrying the same key can't double-spend either).
// =============================================================================

async function testClientMessageIdempotency(admin) {
  const A = await createTestUser();
  const B = await createTestUser();
  const tokenA = mintAccessToken(A);

  const aWallet = await walletRow(admin, A, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 20, 'manual_adjustment')`,
    [aWallet.id],
  );

  const clientMessageId1 = crypto.randomUUID();
  const first = await callSendMessage(tokenA, {
    recipient_id: B,
    body: wordMessage(10),
    client_message_id: clientMessageId1,
  });
  log(
    'first send with a client_message_id succeeds normally',
    first.status === 200 && first.json?.credits_charged === 2,
    JSON.stringify(first.json),
  );
  const threadId = first.json.thread_id;

  // Sequential retry: same key, same thread — simulates the outbox re-firing
  // after a dropped connection once it never received the first response.
  const retry = await callSendMessage(tokenA, {
    thread_id: threadId,
    client_message_id: clientMessageId1,
    body: wordMessage(10),
  });
  log(
    'sequential retry with the same client_message_id returns the original message_id',
    retry.status === 200 && retry.json?.message_id === first.json.message_id,
    JSON.stringify(retry.json),
  );
  log(
    'sequential retry does not re-charge credits',
    Number(retry.json?.payer_balance_after) === Number(first.json.payer_balance_after),
    `first=${first.json.payer_balance_after} retry=${retry.json?.payer_balance_after}`,
  );

  const aWalletAfterRetry = await walletRow(admin, A, 'topup_credit');
  log(
    "A's wallet only reflects one debit after the sequential retry (20 - 2 = 18)",
    Number(aWalletAfterRetry.balance) === 18,
    `balance=${aWalletAfterRetry.balance}`,
  );

  const dupCount = await admin.query(
    'select count(*)::int as n from public.messages where client_message_id = $1',
    [clientMessageId1],
  );
  log(
    'exactly one message row exists for the retried client_message_id',
    dupCount.rows[0].n === 1,
    `n=${dupCount.rows[0].n}`,
  );

  // Concurrency case: two genuinely simultaneous requests with a *new*,
  // shared client_message_id against the same thread. fn_send_message's own
  // `select ... for update` on the thread row serializes these — the second
  // call only proceeds once the first commits, at which point its own
  // replay check finds the row already inserted.
  const clientMessageId2 = crypto.randomUUID();
  const [concurrentA, concurrentB] = await Promise.all([
    callSendMessage(tokenA, {
      thread_id: threadId,
      client_message_id: clientMessageId2,
      body: wordMessage(5),
    }),
    callSendMessage(tokenA, {
      thread_id: threadId,
      client_message_id: clientMessageId2,
      body: wordMessage(5),
    }),
  ]);
  log(
    'both concurrent calls with the same client_message_id succeed (HTTP 200)',
    concurrentA.status === 200 && concurrentB.status === 200,
    `a=${JSON.stringify(concurrentA.json)} b=${JSON.stringify(concurrentB.json)}`,
  );
  log(
    'both concurrent calls resolve to the exact same message_id',
    concurrentA.json?.message_id === concurrentB.json?.message_id,
    `a=${concurrentA.json?.message_id} b=${concurrentB.json?.message_id}`,
  );

  const aWalletAfterConcurrent = await walletRow(admin, A, 'topup_credit');
  log(
    'concurrent duplicate calls only debit once (18 - 2 = 16, a 5-word message)',
    Number(aWalletAfterConcurrent.balance) === 16,
    `balance=${aWalletAfterConcurrent.balance}`,
  );

  const dupCount2 = await admin.query(
    'select count(*)::int as n from public.messages where client_message_id = $1',
    [clientMessageId2],
  );
  log(
    'exactly one message row exists for the concurrently-retried client_message_id',
    dupCount2.rows[0].n === 1,
    `n=${dupCount2.rows[0].n}`,
  );

  const ledgerOk = (await ledgerSum(admin, aWallet.id)) === Number(aWalletAfterConcurrent.balance);
  log(
    "ledger conservation holds on A's wallet after both retries",
    ledgerOk,
    `sum=${await ledgerSum(admin, aWallet.id)} balance=${aWalletAfterConcurrent.balance}`,
  );

  await deleteTestThread(admin, threadId);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 4: reply/forward (docs, punch-list item 1 chat-actions pass) —
// reply_to_message_id must be a real message in the *same* thread (never
// trusted blindly from the client), and is_forwarded is purely a display
// tag that never changes billing.
// =============================================================================

async function testReplyAndForward(admin) {
  const A = await createTestUser();
  const B = await createTestUser();
  const C = await createTestUser();
  const tokenA = mintAccessToken(A);

  const aWallet = await walletRow(admin, A, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, 20, 'manual_adjustment')`,
    [aWallet.id],
  );

  const first = await callSendMessage(tokenA, { recipient_id: B, body: wordMessage(10) });
  const threadId = first.json.thread_id;
  const firstMessageId = first.json.message_id;

  const reply = await callSendMessage(tokenA, {
    thread_id: threadId,
    body: 'replying to my own first message',
    reply_to_message_id: firstMessageId,
  });
  log(
    'a reply to a real message in the same thread succeeds',
    reply.status === 200,
    JSON.stringify(reply.json),
  );

  const replyRow = (
    await admin.query('select reply_to_message_id from public.messages where id = $1', [
      reply.json.message_id,
    ])
  ).rows[0];
  log(
    'reply_to_message_id is actually stored on the new message',
    replyRow.reply_to_message_id === firstMessageId,
    `stored=${replyRow.reply_to_message_id}`,
  );

  // A second thread (A/C) that firstMessageId has nothing to do with — a
  // reply_to_message_id from a completely different thread must be
  // rejected, not silently accepted (it would otherwise let a client quote
  // into a conversation it has no business referencing).
  const otherThread = await callSendMessage(tokenA, { recipient_id: C, body: 'hi C' });
  const crossThreadReply = await callSendMessage(tokenA, {
    thread_id: otherThread.json.thread_id,
    body: 'trying to quote a message from a different thread',
    reply_to_message_id: firstMessageId,
  });
  log(
    'a reply_to_message_id from a different thread is rejected',
    crossThreadReply.status === 400 && crossThreadReply.json?.error === 'invalid_reply_target',
    JSON.stringify(crossThreadReply.json),
  );

  const forwarded = await callSendMessage(tokenA, {
    thread_id: threadId,
    body: 'this is a forwarded message',
    is_forwarded: true,
  });
  const forwardedRow = (
    await admin.query('select is_forwarded, credits_charged from public.messages where id = $1', [
      forwarded.json.message_id,
    ])
  ).rows[0];
  log(
    'is_forwarded is stored and billed exactly like a normal message (not free)',
    forwardedRow.is_forwarded === true && Number(forwardedRow.credits_charged) > 0,
    JSON.stringify(forwardedRow),
  );

  await deleteTestThread(admin, threadId);
  await deleteTestThread(admin, otherThread.json.thread_id);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
  await deleteTestUser(admin, C);
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  // -A (allow-all): this is test tooling running the function outside
  // Supabase's own sandboxed edge runtime, which is what actually
  // constrains permissions in production/local `functions serve` — no
  // equivalent trust boundary to preserve here.
  const deno = spawn('deno', ['run', '-A', FUNCTION_ENTRY], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  try {
    await waitForFunctionReady(15000);

    await testFullPaidExchange(admin);
    await testErrorMapping(admin);
    await testClientMessageIdempotency(admin);
    await testReplyAndForward(admin);
  } finally {
    deno.kill();
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;

  // Force-exit rather than let the event loop drain naturally: the first
  // run of this suite hung indefinitely after every assertion had already
  // logged (all 20 passed) with nothing further printed — most likely a
  // stray open handle (the killed `deno` child's stdio pipes, or a
  // lingering fetch keep-alive socket) rather than anything test logic
  // actually waits on. Once every real cleanup step above has run,
  // there's nothing left worth waiting on.
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
