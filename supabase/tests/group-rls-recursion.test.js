#!/usr/bin/env node
// Regression test for the group RLS recursion bug fixed in
// 20260919130000_fix_group_rls_recursion.sql — confirmed live 2026-09-19
// after a real user created 3 groups and could see none of them: every
// prior group test (create-group-thread-function.test.js,
// send-group-message-function.test.js, group-chat-functions.test.js,
// group-admin-actions-function.test.js) verifies state via a raw `pg`
// connection (RLS doesn't apply) or Edge Functions using
// serviceRoleClient() (service-role bypasses RLS entirely) — none of them
// ever ran the actual anon-key + user-JWT SELECT the mobile app's
// useGroups/useGroupInfo/useGroupMembers/useGroupMessages hooks use. This
// test exercises exactly that path, the same one the phone exercises, so
// a self-referencing (or any other recursive) RLS policy on
// group_threads/group_members/group_messages can never regress silently
// again.

const { Client } = require('pg');
const crypto = require('crypto');

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
    console.error(`${name} is not set. Run via \`npm run test:group-rls\` from the repo root.`);
    process.exit(1);
  }
}

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

async function deleteTestUser(id) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

/** A raw PostgREST request as one user via a minted JWT — same
 * `${SUPABASE_URL}/rest/v1/<table>?select=...` + apikey/Authorization
 * headers shape mark-thread-read-function.test.js's own fetchUnreadCounts
 * already establishes for this repo's RLS-exercising tests, rather than
 * `@supabase/supabase-js`'s `createClient` (which eagerly sets up a
 * realtime client that needs a global `WebSocket` — present in a real RN
 * app and in Node 22+, but not in this CI's Node 20, so it threw
 * "Node.js detected but native WebSocket not found" with zero realtime
 * subscriptions ever touched). PostgREST enforces RLS identically
 * regardless of which HTTP client sends the request, so this still
 * exercises exactly the policy path apps/mobile/lib/supabase.ts's real
 * client hits. */
async function selectAs(userId, table, queryString) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${queryString}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${mintAccessToken(userId)}` },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      data: null,
      error: { message: json?.message ?? `HTTP ${res.status}`, code: json?.code },
    };
  }
  return { data: json, error: null };
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const member = await createTestUser();
  const outsider = await createTestUser();
  let groupId;

  try {
    const groupRow = await admin.query(
      `insert into group_threads (name, created_by) values ('RLS Test Group', $1) returning id`,
      [member],
    );
    groupId = groupRow.rows[0].id;
    await admin.query(
      `insert into group_members (group_thread_id, user_id, role) values ($1, $2, 'admin')`,
      [groupId, member],
    );
    const msgRow = await admin.query(
      `insert into group_messages (group_thread_id, sender_id, body, word_count, credits_charged)
       values ($1, $2, 'hello', 1, 0) returning id`,
      [groupId, member],
    );
    const messageId = msgRow.rows[0].id;

    const { data: threads, error: threadsErr } = await selectAs(
      member,
      'group_threads',
      `select=id,name&id=eq.${groupId}`,
    );
    log(
      'member can select group_threads without a recursion error',
      !threadsErr && threads?.length === 1,
      threadsErr ? threadsErr.message : JSON.stringify(threads),
    );

    const { data: members, error: membersErr } = await selectAs(
      member,
      'group_members',
      `select=user_id,role&group_thread_id=eq.${groupId}`,
    );
    log(
      'member can select group_members without a recursion error',
      !membersErr && members?.length === 1,
      membersErr ? membersErr.message : JSON.stringify(members),
    );

    const { data: msgs, error: msgsErr } = await selectAs(
      member,
      'group_messages',
      `select=id,body&group_thread_id=eq.${groupId}`,
    );
    log(
      'member can select group_messages without a recursion error',
      !msgsErr && msgs?.some((m) => m.id === messageId),
      msgsErr ? msgsErr.message : JSON.stringify(msgs),
    );

    const { data: outsiderThreads, error: outsiderThreadsErr } = await selectAs(
      outsider,
      'group_threads',
      `select=id&id=eq.${groupId}`,
    );
    log(
      'a non-member sees zero rows (not an error) on group_threads',
      !outsiderThreadsErr && outsiderThreads?.length === 0,
      outsiderThreadsErr ? outsiderThreadsErr.message : JSON.stringify(outsiderThreads),
    );

    const { data: outsiderMembers, error: outsiderMembersErr } = await selectAs(
      outsider,
      'group_members',
      `select=user_id&group_thread_id=eq.${groupId}`,
    );
    log(
      'a non-member sees zero rows (not an error) on group_members',
      !outsiderMembersErr && outsiderMembers?.length === 0,
      outsiderMembersErr ? outsiderMembersErr.message : JSON.stringify(outsiderMembers),
    );
  } finally {
    if (groupId) {
      await admin.query('delete from group_messages where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_members where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_threads where id = $1', [groupId]);
    }
    await deleteTestUser(member);
    await deleteTestUser(outsider);
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
