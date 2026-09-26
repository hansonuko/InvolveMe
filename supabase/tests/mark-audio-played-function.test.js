#!/usr/bin/env node
// End-to-end test of the mark-audio-played Edge Function against the real
// linked dev database — real JWTs, real HTTP function, real error
// mapping, same pattern message-delete-function.test.js already
// establishes for a lightweight non-financial mutation. fn_mark_audio_
// played's own logic (docs/17-VOICE-NOTES-SCOPING.md §8,
// 20260926110000_chat_audio_messages_pipeline.sql) is exercised here for
// the first time — this pipeline shipped with no Edge Function wrapping
// it (session 36 built the client, and this function, together).

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
    console.error(
      `${name} is not set. Run via \`npm run test:mark-audio-played\` from the repo root.`,
    );
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'mark-audio-played', 'index.ts');

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
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
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

const TINY_M4A = Buffer.from('00000018667479704D3441200000000069736F6D', 'hex');

/** Same fixture-upload approach send-message-chat-audio-function.test.js
 * already established — bypasses the signed-upload-URL flow via the
 * service-role key directly, same net effect as a real upload completing. */
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

async function fundTopupCredit(admin, userId, credits) {
  const wallet = (
    await admin.query(
      `select id from public.wallets where user_id = $1 and kind = 'topup_credit'`,
      [userId],
    )
  ).rows[0];
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.id, credits],
  );
}

async function seedAudioMessage(admin, threadId, senderId) {
  const audioPath = await uploadFixtureAudio(senderId);
  const {
    rows: [sent],
  } = await admin.query(
    `select * from public.fn_send_message(
       p_thread_id => $1, p_sender_id => $2, p_body => '',
       p_media_path => $3, p_media_type => 'audio', p_duration_seconds => 5
     )`,
    [threadId, senderId, audioPath],
  );
  return sent.message_id;
}

async function callMarkAudioPlayed(token, body) {
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
  throw new Error('mark-audio-played function did not come up in time');
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
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));

  const A = await createTestUser();
  const B = await createTestUser();
  const C = await createTestUser();
  const tokenA = mintAccessToken(A);
  const tokenB = mintAccessToken(B);
  const tokenC = mintAccessToken(C);
  let threadId;

  try {
    await waitForFunctionReady(15000);

    await fundTopupCredit(admin, A, 20);
    const {
      rows: [thread],
    } = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
    threadId = thread.id;

    const audioMessageId = await seedAudioMessage(admin, threadId, A);

    const noAuth = await callMarkAudioPlayed('', { message_id: audioMessageId });
    log('missing/invalid auth -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const badId = await callMarkAudioPlayed(tokenB, { message_id: 'not-a-uuid' });
    log(
      'non-UUID message_id -> 400 invalid_request',
      badId.status === 400 && badId.json?.error === 'invalid_request',
      JSON.stringify(badId.json),
    );

    const unknown = await callMarkAudioPlayed(tokenB, { message_id: crypto.randomUUID() });
    log(
      'unknown message id -> 404 message_not_found',
      unknown.status === 404 && unknown.json?.error === 'message_not_found',
      JSON.stringify(unknown.json),
    );

    const bySender = await callMarkAudioPlayed(tokenA, { message_id: audioMessageId });
    log(
      "the sender can't mark their own voice note played -> 400",
      bySender.status === 400 && bySender.json?.error === 'cannot_mark_own_message_played',
      JSON.stringify(bySender.json),
    );

    const byOutsider = await callMarkAudioPlayed(tokenC, { message_id: audioMessageId });
    log(
      'a non-participant is rejected -> 403 not_a_participant',
      byOutsider.status === 403 && byOutsider.json?.error === 'not_a_participant',
      JSON.stringify(byOutsider.json),
    );

    const byRecipient = await callMarkAudioPlayed(tokenB, { message_id: audioMessageId });
    log(
      'the recipient marks it played -> 200',
      byRecipient.status === 200,
      JSON.stringify(byRecipient.json),
    );

    const row = (
      await admin.query('select audio_played_at from public.messages where id = $1', [
        audioMessageId,
      ])
    ).rows[0];
    log('audio_played_at is actually set', !!row.audio_played_at, JSON.stringify(row));
    const firstPlayedAt = row.audio_played_at;

    const again = await callMarkAudioPlayed(tokenB, { message_id: audioMessageId });
    log(
      'calling it again is a harmless no-op, still 200',
      again.status === 200,
      JSON.stringify(again.json),
    );

    const rowAfter = (
      await admin.query('select audio_played_at from public.messages where id = $1', [
        audioMessageId,
      ])
    ).rows[0];
    log(
      'audio_played_at is not overwritten by a second call',
      new Date(rowAfter.audio_played_at).getTime() === new Date(firstPlayedAt).getTime(),
      JSON.stringify(rowAfter),
    );

    // A text (non-audio) message on the same thread should be rejected —
    // this is audio-only signal, not a generic "mark read" mechanism.
    const {
      rows: [textMsg],
    } = await admin.query(
      `select * from public.fn_send_message(p_thread_id => $1, p_sender_id => $2, p_body => 'hello')`,
      [threadId, A],
    );
    const onTextMessage = await callMarkAudioPlayed(tokenB, { message_id: textMsg.message_id });
    log(
      'a text message is rejected -> 400 not_an_audio_message',
      onTextMessage.status === 400 && onTextMessage.json?.error === 'not_an_audio_message',
      JSON.stringify(onTextMessage.json),
    );
  } finally {
    deno.kill();
    if (threadId) await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    await deleteTestUser(admin, C);
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
