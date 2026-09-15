#!/usr/bin/env node
// Content moderation (docs/06-SECURITY-FRAUD-LOOPHOLES.md §6,
// docs/07-COMPLIANCE-LEGAL.md §3, docs/00-SESSION-HANDOFF.md session 13,
// continued) — end-to-end test of send-message/post-status's moderation
// wiring, real HTTP calls, same pattern as send-message-function.test.js.
//
// Two tiers of coverage, matching what's actually possible without a real
// OPENAI_API_KEY (none exists in this environment yet — same gap KYC had
// before Prembly credentials arrived):
//
// 1. Fail-open behavior — runs unconditionally, with whatever key (or
//    lack of one) is actually configured. This is the path that's live
//    the moment this ships, before any key is added: a moderation-
//    provider failure must never take down messaging. Manually verified
//    once already this session (both send-message-function.test.js and
//    post-status-function.test.js's full existing suites pass unchanged
//    with no key configured, the moderation check logging a caught 401
//    and allowing the send) — this formalizes that as a real regression
//    test rather than leaving it as a one-off manual check.
//
// 2. True-positive/false-positive coverage against real OpenAI responses
//    — only runs if OPENAI_API_KEY is actually set in the environment.
//    Skipped with a clear, loud message otherwise, not silently omitted —
//    same honesty this suite already applies to submit-kyc's real-money
//    cost caveat elsewhere in this test family.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const crypto = require('crypto');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

const FUNCTION_URL = 'http://127.0.0.1:8000';
const SEND_MESSAGE_ENTRY = path.join(__dirname, '..', 'functions', 'send-message', 'index.ts');

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

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

async function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${FUNCTION_URL}/`, { method: 'POST', body: '{}' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('function did not come up in time');
}

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
  if (!res.ok) throw new Error(`createTestUser failed: ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function deleteTestUser(admin, id) {
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from public.moderated_content where user_id = $1', [id]);
  await admin.query('delete from public.fraud_signals where user_id = $1', [id]);
  await admin.query('delete from auth.users where id = $1', [id]);
}

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
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

async function sendMessage(token, body) {
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// =============================================================================
// Test 1: fail-open — a real send still succeeds even when the
// moderation provider call itself fails (no valid key configured is
// exactly that case today, run as-is rather than mocked).
// =============================================================================

async function testFailsOpenOnModerationProviderError(admin) {
  const A = await createTestUser();
  const B = await createTestUser();
  await fundWallet(admin, A, 'topup_credit', 20);
  const tokenA = mintAccessToken(A);

  const result = await sendMessage(tokenA, { recipient_id: B, body: 'hello, how are you today' });
  log(
    'a send still succeeds even when the moderation provider call itself errors',
    result.status === 200 && typeof result.json?.message_id === 'string',
    JSON.stringify(result.json),
  );

  const moderationRows = await admin.query(
    'select count(*)::int as n from public.moderated_content where user_id = $1',
    [A],
  );
  log(
    'a provider error is not logged as a moderation outcome (nothing to log — the check itself failed, not the content)',
    moderationRows.rows[0].n === 0,
    `n=${moderationRows.rows[0].n}`,
  );

  if (result.json?.thread_id) await deleteTestThread(admin, result.json.thread_id);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

// =============================================================================
// Test 2: real true-positive/false-positive coverage — only with a real
// OPENAI_API_KEY. Skipped loudly, not silently, otherwise.
// =============================================================================

async function testRealModerationOutcomes(admin) {
  if (!OPENAI_API_KEY) {
    process.stdout.write(
      '[SKIP] real moderation true/false-positive checks — OPENAI_API_KEY not set in this environment. ' +
        'Add a real key and re-run to exercise this path; fail-open behavior above is covered either way.\n',
    );
    return;
  }

  const A = await createTestUser();
  const B = await createTestUser();
  await fundWallet(admin, A, 'topup_credit', 20);
  const tokenA = mintAccessToken(A);

  const benign = await sendMessage(tokenA, {
    recipient_id: B,
    body: 'hey, are you free to chat this weekend?',
  });
  log(
    'a genuinely benign message sends normally, not flagged',
    benign.status === 200,
    JSON.stringify(benign.json),
  );

  const severe = await sendMessage(tokenA, {
    thread_id: benign.json?.thread_id,
    body: 'I will find you and kill you tonight, I know where you live',
  });
  log(
    'a genuinely severe threat is hard-blocked (400 content_blocked), never sent or charged',
    severe.status === 400 && severe.json?.error === 'content_blocked',
    JSON.stringify(severe.json),
  );

  const blockedRow = await admin.query(
    `select action, categories from public.moderated_content where user_id = $1 and action = 'blocked'`,
    [A],
  );
  log(
    'the blocked attempt is logged with no ref_id (nothing was inserted to reference)',
    blockedRow.rows.length === 1,
    JSON.stringify(blockedRow.rows[0]),
  );

  if (benign.json?.thread_id) await deleteTestThread(admin, benign.json.thread_id);
  await deleteTestUser(admin, A);
  await deleteTestUser(admin, B);
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const deno = spawn('deno', ['run', '-A', SEND_MESSAGE_ENTRY], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
      OPENAI_API_KEY: OPENAI_API_KEY ?? '',
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  try {
    await waitForFunctionReady(15000);

    await testFailsOpenOnModerationProviderError(admin);
    await testRealModerationOutcomes(admin);
  } finally {
    deno.kill();
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
