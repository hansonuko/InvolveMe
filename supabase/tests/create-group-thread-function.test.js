#!/usr/bin/env node
// End-to-end test of the create-group-thread Edge Function
// (supabase/functions/create-group-thread/) against the real linked dev
// database, same pattern mark-thread-read-function.test.js already
// establishes: spawn the function locally via `deno run`, hit it with a
// real signed JWT for a real (throwaway) user. No financial logic, no live
// provider dependency.

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
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'create-group-thread', 'index.ts');

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

async function callCreateGroupThread(token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers,
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
  throw new Error('create-group-thread function did not come up in time');
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
  let groupId;

  try {
    await waitForFunctionReady(15000);

    const noAuth = await callCreateGroupThread(null, { name: 'X', member_ids: [B] });
    log('missing Authorization header -> 401', noAuth.status === 401, `status=${noAuth.status}`);

    const noName = await callCreateGroupThread(tokenA, { member_ids: [B] });
    log(
      'missing name -> 400 group_name_required',
      noName.status === 400 && noName.json?.error === 'group_name_required',
      JSON.stringify(noName.json),
    );

    const noMembers = await callCreateGroupThread(tokenA, { name: 'Solo group', member_ids: [] });
    log(
      'empty member_ids -> 400 group_needs_members',
      noMembers.status === 400 && noMembers.json?.error === 'group_needs_members',
      JSON.stringify(noMembers.json),
    );

    const unknownMember = await callCreateGroupThread(tokenA, {
      name: 'Ghost',
      member_ids: [crypto.randomUUID()],
    });
    log(
      'unknown member id -> 400 member_not_found',
      unknownMember.status === 400 && unknownMember.json?.error === 'member_not_found',
      JSON.stringify(unknownMember.json),
    );

    const created = await callCreateGroupThread(tokenA, {
      name: '  Weekend Trip  ',
      member_ids: [B, C, A], // A (the creator) echoed back in — must be deduped, not rejected
    });
    log(
      'valid request -> 200 with a real group_thread_id',
      created.status === 200 && typeof created.json?.group_thread_id === 'string',
      JSON.stringify(created.json),
    );
    groupId = created.json?.group_thread_id;

    const groupRow = (
      await admin.query('select name, created_by from group_threads where id = $1', [groupId])
    ).rows[0];
    log('group name trimmed', groupRow?.name === 'Weekend Trip', JSON.stringify(groupRow));
    log('creator is created_by', groupRow?.created_by === A);

    const memberRows = (
      await admin.query('select user_id, role from group_members where group_thread_id = $1', [
        groupId,
      ])
    ).rows;
    log(
      'exactly 3 members, creator not doubled despite being echoed back in the request',
      memberRows.length === 3,
      JSON.stringify(memberRows),
    );
    log('creator has role=admin', memberRows.find((r) => r.user_id === A)?.role === 'admin');
  } finally {
    deno.kill();
    if (groupId) {
      await admin.query('delete from group_messages where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_members where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_threads where id = $1', [groupId]);
    }
    await deleteTestUser(A);
    await deleteTestUser(B);
    await deleteTestUser(C);
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
