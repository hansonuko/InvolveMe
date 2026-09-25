#!/usr/bin/env node
// End-to-end test of send-message's voice-note (audio) support
// (docs/17-VOICE-NOTES-SCOPING.md, 20260926110000_chat_audio_messages_pipeline.sql).
// Same real-HTTP-function/real-JWT approach as
// send-message-chat-media-function.test.js (this file's own sibling for
// photos) — split out as its own suite rather than bolted onto that one,
// same convention every prior media-adjacent piece has followed.

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

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'send-message', 'index.ts');

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
    `delete from public.ledger_entries where wallet_id in (
       select id from public.wallets where user_id = $1
     )`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from auth.users where id = $1', [id]);
}

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
  const r = await admin.query(
    "select value from public.pricing_config where key = $1 and currency = 'NGN'",
    [key],
  );
  return Number(r.rows[0].value);
}

const TINY_M4A = Buffer.from('00000018667479704D3441200000000069736F6D', 'hex');

/** Uploads directly via the Storage REST API using the service-role key —
 * bypasses RLS/signed-URL-token requirements entirely (same net effect a
 * real signed-upload-URL flow completing normally has). Path always
 * `${userId}/${uuid}.m4a`, matching create-chat-media-upload-url's real
 * kind: 'audio' convention exactly — what fn_send_message's ownership
 * check validates against. */
async function uploadFixtureAudio(userId) {
  const objectPath = `${userId}/${crypto.randomUUID()}.m4a`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/chat-media/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'audio/m4a',
    },
    body: TINY_M4A,
  });
  if (!res.ok) throw new Error(`uploadFixtureAudio failed: ${res.status} ${await res.text()}`);
  return objectPath;
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
      await fetch(`${FUNCTION_URL}/`, { method: 'POST', body: '{}' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('send-message function did not come up in time');
}

async function fundTopupCredit(admin, userId, credits) {
  const wallet = await walletRow(admin, userId, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.id, credits],
  );
  return wallet;
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const deno = spawn('deno', ['run', '-A', FUNCTION_ENTRY], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stdout.write(`[deno] ${d}`));

  const baseCredits = await pricingValue(admin, 'message_base_credits');
  const audioCredits = await pricingValue(admin, 'message_audio_credits');
  const maxAudioSeconds = await pricingValue(admin, 'message_audio_max_seconds');

  const cleanupUsers = [];
  const cleanupThreads = [];

  try {
    await waitForFunctionReady(15000);

    // ---------------------------------------------------------------------
    // Test 1: a captionless voice note is a real, valid message — base
    // credits (word_count=0 floor) + the audio surcharge (its own key,
    // not message_media_credits), duration/waveform actually stored.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureAudio(A);
      const waveform = [10, 40, 80, 55, 20];
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'audio',
        duration_seconds: 12,
        waveform_samples: waveform,
      });
      log(
        'captionless voice note succeeds (HTTP 200)',
        result.status === 200,
        JSON.stringify(result.json),
      );
      log(
        `charges base + audio surcharge (${baseCredits} + ${audioCredits} = ${baseCredits + audioCredits}), not message_media_credits`,
        result.json?.credits_charged === baseCredits + audioCredits,
        JSON.stringify(result.json),
      );

      const threadId = result.json.thread_id;
      cleanupThreads.push(threadId);
      const row = await admin.query(
        'select media_path, media_type, duration_seconds, waveform_samples, audio_played_at from public.messages where id = $1',
        [result.json.message_id],
      );
      log(
        'duration_seconds/waveform_samples are actually stored, audio_played_at starts null',
        row.rows[0].duration_seconds === 12 &&
          JSON.stringify(row.rows[0].waveform_samples) === JSON.stringify(waveform) &&
          row.rows[0].audio_played_at === null,
        JSON.stringify(row.rows[0]),
      );

      const wallet = await walletRow(admin, A, 'topup_credit');
      const ok = (await ledgerSum(admin, wallet.id)) === Number(wallet.balance);
      log('ledger conservation holds after a voice-note send', ok, `balance=${wallet.balance}`);
    }

    // ---------------------------------------------------------------------
    // Test 2: a voice note over the server-enforced max duration is
    // rejected — not just a client-side UX convention (docs/17 §4).
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureAudio(A);
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'audio',
        duration_seconds: maxAudioSeconds + 1,
      });
      log(
        'a voice note over message_audio_max_seconds is rejected',
        result.status === 400 && result.json?.error === 'audio_too_long',
        JSON.stringify(result.json),
      );

      const walletAfter = await walletRow(admin, A, 'topup_credit');
      log('the rejected attempt never charged anything', Number(walletAfter.balance) === 20);
    }

    // ---------------------------------------------------------------------
    // Test 3: waveform_samples values out of [0,100] are rejected at the
    // Edge Function layer, before ever reaching the DB.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureAudio(A);
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'audio',
        duration_seconds: 5,
        waveform_samples: [10, 200, 30], // 200 is out of range
      });
      log(
        'an out-of-range waveform sample is rejected',
        result.status === 400 && result.json?.error === 'invalid_waveform_samples',
        JSON.stringify(result.json),
      );
    }

    // ---------------------------------------------------------------------
    // Test 4: audio without duration_seconds is rejected.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureAudio(A);
      const result = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'audio',
      });
      log(
        'audio with no duration_seconds is rejected',
        result.status === 400 && result.json?.error === 'invalid_duration',
        JSON.stringify(result.json),
      );
    }

    // ---------------------------------------------------------------------
    // Test 5: escrow release still works for a voice-note message.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      const tokenB = mintAccessToken(B);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureAudio(A);
      const first = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'audio',
        duration_seconds: 8,
      });
      const threadId = first.json.thread_id;
      cleanupThreads.push(threadId);

      const reply = await callSendMessage(tokenB, { thread_id: threadId, body: 'thanks!' });
      log(
        'B can reply to a voice-note message (HTTP 200)',
        reply.status === 200,
        JSON.stringify(reply.json),
      );

      const msgs = await admin.query(
        'select status, media_type from public.messages where thread_id = $1 order by created_at',
        [threadId],
      );
      log(
        "A's voice-note message escrow released once B replied",
        msgs.rows[0].status === 'released' && msgs.rows[0].media_type === 'audio',
        JSON.stringify(msgs.rows),
      );
    }

    // ---------------------------------------------------------------------
    // Test 6: concurrency — two simultaneous voice-note sends with the
    // same client_message_id can't double-spend (CLAUDE.md's required
    // concurrency case for any balance-mutating function).
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureAudio(A);
      const clientMessageId = crypto.randomUUID();
      const [a, b] = await Promise.all([
        callSendMessage(tokenA, {
          recipient_id: B,
          body: '',
          media_path: objectPath,
          media_type: 'audio',
          duration_seconds: 6,
          client_message_id: clientMessageId,
        }),
        callSendMessage(tokenA, {
          recipient_id: B,
          body: '',
          media_path: objectPath,
          media_type: 'audio',
          duration_seconds: 6,
          client_message_id: clientMessageId,
        }),
      ]);
      log(
        'both concurrent calls with the same client_message_id succeed',
        a.status === 200 && b.status === 200,
        `a=${JSON.stringify(a.json)} b=${JSON.stringify(b.json)}`,
      );
      log(
        'both resolve to the same message_id, only charged once',
        a.json?.message_id === b.json?.message_id,
        `a=${a.json?.message_id} b=${b.json?.message_id}`,
      );

      const threadIdOrNull = a.json?.thread_id ?? b.json?.thread_id;
      if (threadIdOrNull) cleanupThreads.push(threadIdOrNull);

      const wallet = await walletRow(admin, A, 'topup_credit');
      log(
        `only charged once (20 - ${baseCredits + audioCredits} = ${20 - (baseCredits + audioCredits)})`,
        Number(wallet.balance) === 20 - (baseCredits + audioCredits),
        `balance=${wallet.balance}`,
      );
      const ok = (await ledgerSum(admin, wallet.id)) === Number(wallet.balance);
      log('ledger conservation holds after the concurrent voice-note send', ok);
    }

    // ---------------------------------------------------------------------
    // Test 7: fn_mark_audio_played — the recipient can mark it played
    // once, idempotently; the sender cannot mark their own message played.
    // ---------------------------------------------------------------------
    {
      const A = await createTestUser();
      const B = await createTestUser();
      cleanupUsers.push(A, B);
      const tokenA = mintAccessToken(A);
      await fundTopupCredit(admin, A, 20);

      const objectPath = await uploadFixtureAudio(A);
      const sent = await callSendMessage(tokenA, {
        recipient_id: B,
        body: '',
        media_path: objectPath,
        media_type: 'audio',
        duration_seconds: 4,
      });
      cleanupThreads.push(sent.json.thread_id);

      const selfMark = await admin
        .query('select public.fn_mark_audio_played($1, $2)', [sent.json.message_id, A])
        .catch((e) => e);
      log(
        'the sender cannot mark their own voice note played',
        selfMark instanceof Error && /cannot_mark_own_message_played/.test(selfMark.message),
        String(selfMark),
      );

      await admin.query('select public.fn_mark_audio_played($1, $2)', [sent.json.message_id, B]);
      await admin.query('select public.fn_mark_audio_played($1, $2)', [sent.json.message_id, B]); // idempotent

      const row = await admin.query('select audio_played_at from public.messages where id = $1', [
        sent.json.message_id,
      ]);
      log(
        'audio_played_at is set after the recipient marks it played',
        row.rows[0].audio_played_at !== null,
        JSON.stringify(row.rows[0]),
      );
    }
  } finally {
    deno.kill();
    for (const threadId of cleanupThreads) {
      await deleteTestThread(admin, threadId).catch(() => {});
    }
    for (const id of cleanupUsers) {
      await deleteTestUser(admin, id).catch(() => {});
    }
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
