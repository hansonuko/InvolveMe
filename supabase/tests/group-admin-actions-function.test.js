#!/usr/bin/env node
// End-to-end test of the six group-admin Edge Functions (punch-list item
// 2, 2026-09-19): add-group-members, remove-group-member, leave-group,
// set-group-member-role, update-group-profile,
// create-group-avatar-upload-url. Same pattern
// create-group-thread-function.test.js already establishes: spawn each
// function locally via `deno run` against the real linked dev database,
// hit it with a real signed JWT for a real (throwaway) user, tear
// everything down after. Sequential, one function process at a time
// (all bind to the same default port 8000) rather than six separate test
// files, since these six functions share one group-lifecycle test fixture
// (a real group with an owner, an admin, and two plain members) that's
// expensive to set up per-file.

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
    console.error(`${name} is not set. Run via \`npm run test:group-admin\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';

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

async function callFunction(token, body) {
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
  throw new Error('function did not come up in time');
}

/** Spawns one function's deno process, runs `testFn`, always tears the
 * process down after — even on a thrown assertion — so a failure in one
 * function's block never leaves a stray process bound to port 8000
 * blocking the next block. */
async function withFunction(functionName, testFn) {
  const entry = path.join(__dirname, '..', 'functions', functionName, 'index.ts');
  const deno = spawn('deno', ['run', '-A', entry], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno:${functionName}] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno:${functionName}] ${d}`));
  try {
    await waitForFunctionReady(15000);
    await testFn();
  } finally {
    deno.kill();
    // Give the OS a moment to release port 8000 before the next spawn.
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  // Fixture: owner (created the group, fixed admin), plainMember (a
  // regular member), outsider (not in the group at all), joinable (not yet
  // a member — added mid-test).
  const owner = await createTestUser();
  const plainMember = await createTestUser();
  const outsider = await createTestUser();
  const joinable = await createTestUser();
  const tokenOwner = mintAccessToken(owner);
  const tokenPlainMember = mintAccessToken(plainMember);
  const tokenOutsider = mintAccessToken(outsider);

  let groupId;

  try {
    const groupRow = await admin.query(
      `insert into group_threads (name, created_by) values ('Test Group', $1) returning id`,
      [owner],
    );
    groupId = groupRow.rows[0].id;
    await admin.query(
      `insert into group_members (group_thread_id, user_id, role) values ($1, $2, 'admin'), ($1, $3, 'member')`,
      [groupId, owner, plainMember],
    );

    // --- add-group-members: any current member (not just admin) can add ---
    await withFunction('add-group-members', async () => {
      const byOutsider = await callFunction(tokenOutsider, {
        group_thread_id: groupId,
        member_ids: [joinable],
      });
      log(
        'add: a non-member is rejected',
        byOutsider.status === 403 && byOutsider.json?.error === 'not_a_member',
        JSON.stringify(byOutsider.json),
      );

      const byPlainMember = await callFunction(tokenPlainMember, {
        group_thread_id: groupId,
        member_ids: [joinable, owner], // owner echoed back in — already a member, should just be skipped
      });
      log(
        'add: a plain (non-admin) member can add — added_count=1 (owner already a member, skipped)',
        byPlainMember.status === 200 && byPlainMember.json?.added_count === 1,
        JSON.stringify(byPlainMember.json),
      );

      const unknown = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        member_ids: [crypto.randomUUID()],
      });
      log(
        'add: unknown user id -> member_not_found',
        unknown.status === 400 && unknown.json?.error === 'member_not_found',
        JSON.stringify(unknown.json),
      );
    });

    const memberIds = (
      await admin.query('select user_id from group_members where group_thread_id = $1', [groupId])
    ).rows.map((r) => r.user_id);
    log('joinable is now a real member after add-group-members', memberIds.includes(joinable));

    // --- set-group-member-role: admin-only; owner immutable ---
    await withFunction('set-group-member-role', async () => {
      const byPlainMember = await callFunction(tokenPlainMember, {
        group_thread_id: groupId,
        target_user_id: joinable,
        role: 'admin',
      });
      log(
        'role: a non-admin member cannot promote -> not_admin',
        byPlainMember.status === 403 && byPlainMember.json?.error === 'not_admin',
        JSON.stringify(byPlainMember.json),
      );

      const ownerRoleChange = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        target_user_id: owner,
        role: 'member',
      });
      log(
        'role: nobody can demote the owner -> cannot_change_owner_role',
        ownerRoleChange.status === 400 &&
          ownerRoleChange.json?.error === 'cannot_change_owner_role',
        JSON.stringify(ownerRoleChange.json),
      );

      const promote = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        target_user_id: plainMember,
        role: 'admin',
      });
      log(
        'role: owner promotes plainMember to admin -> 200',
        promote.status === 200,
        JSON.stringify(promote.json),
      );

      const badRole = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        target_user_id: joinable,
        role: 'superadmin',
      });
      log(
        'role: invalid role string -> 400 invalid_request',
        badRole.status === 400 && badRole.json?.error === 'invalid_request',
        JSON.stringify(badRole.json),
      );
    });

    const plainMemberRole = (
      await admin.query(
        'select role from group_members where group_thread_id = $1 and user_id = $2',
        [groupId, plainMember],
      )
    ).rows[0]?.role;
    log('plainMember really is admin now', plainMemberRole === 'admin', plainMemberRole);

    // --- update-group-profile: admin-only; fields independently optional ---
    await withFunction('update-group-profile', async () => {
      const byOutsider = await callFunction(tokenOutsider, {
        group_thread_id: groupId,
        name: 'Hijacked',
      });
      log(
        'profile: a non-member cannot edit -> not_a_member',
        byOutsider.status === 403 && byOutsider.json?.error === 'not_a_member',
        JSON.stringify(byOutsider.json),
      );

      // plainMember is an admin now (promoted above) — any admin, not just
      // the owner, can edit group info.
      const renameByPromotedAdmin = await callFunction(tokenPlainMember, {
        group_thread_id: groupId,
        name: '  Renamed Group  ',
      });
      log(
        'profile: a promoted (non-owner) admin can rename -> 200',
        renameByPromotedAdmin.status === 200,
        JSON.stringify(renameByPromotedAdmin.json),
      );

      const descOnly = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        description: 'A test group',
      });
      log(
        'profile: description-only update -> 200',
        descOnly.status === 200,
        JSON.stringify(descOnly.json),
      );

      const tooLongName = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        name: 'x'.repeat(61),
      });
      log(
        'profile: name over 60 chars -> group_name_too_long',
        tooLongName.status === 400 && tooLongName.json?.error === 'group_name_too_long',
        JSON.stringify(tooLongName.json),
      );

      const blankName = await callFunction(tokenOwner, { group_thread_id: groupId, name: '   ' });
      log(
        'profile: blank name -> group_name_required',
        blankName.status === 400 && blankName.json?.error === 'group_name_required',
        JSON.stringify(blankName.json),
      );
    });

    const groupAfterProfileEdits = (
      await admin.query('select name, description from group_threads where id = $1', [groupId])
    ).rows[0];
    log(
      'name updated, description updated independently, neither clobbered the other',
      groupAfterProfileEdits.name === 'Renamed Group' &&
        groupAfterProfileEdits.description === 'A test group',
      JSON.stringify(groupAfterProfileEdits),
    );

    // --- create-group-avatar-upload-url: admin-only ---
    await withFunction('create-group-avatar-upload-url', async () => {
      const byNonAdminMember = await callFunction(tokenOutsider, { group_thread_id: groupId });
      log(
        'avatar-url: a non-member is rejected',
        byNonAdminMember.status === 403 && byNonAdminMember.json?.error === 'not_a_member',
        JSON.stringify(byNonAdminMember.json),
      );

      const byAdmin = await callFunction(tokenOwner, { group_thread_id: groupId });
      log(
        'avatar-url: an admin gets a signed url for the right path',
        byAdmin.status === 200 &&
          typeof byAdmin.json?.signed_url === 'string' &&
          byAdmin.json?.path === `groups/${groupId}.jpg`,
        JSON.stringify(byAdmin.json),
      );
    });

    // --- remove-group-member: admin-only; owner is unremovable ---
    await withFunction('remove-group-member', async () => {
      const removeOwner = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        target_user_id: owner,
      });
      log(
        'remove: nobody can remove the owner -> cannot_remove_owner',
        removeOwner.status === 400 && removeOwner.json?.error === 'cannot_remove_owner',
        JSON.stringify(removeOwner.json),
      );

      const removeUnknown = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        target_user_id: outsider,
      });
      log(
        'remove: removing a non-member -> target_not_a_member',
        removeUnknown.status === 400 && removeUnknown.json?.error === 'target_not_a_member',
        JSON.stringify(removeUnknown.json),
      );

      const removeJoinable = await callFunction(tokenOwner, {
        group_thread_id: groupId,
        target_user_id: joinable,
      });
      log(
        'remove: owner removes joinable -> 200',
        removeJoinable.status === 200,
        JSON.stringify(removeJoinable.json),
      );
    });

    const joinableStillMember = (
      await admin.query('select 1 from group_members where group_thread_id = $1 and user_id = $2', [
        groupId,
        joinable,
      ])
    ).rowCount;
    log('joinable really was removed from group_members', joinableStillMember === 0);

    // --- leave-group: self-service; owner blocked ---
    await withFunction('leave-group', async () => {
      const ownerLeaves = await callFunction(tokenOwner, { group_thread_id: groupId });
      log(
        'leave: the owner cannot leave -> owner_cannot_leave',
        ownerLeaves.status === 400 && ownerLeaves.json?.error === 'owner_cannot_leave',
        JSON.stringify(ownerLeaves.json),
      );

      const outsiderLeaves = await callFunction(tokenOutsider, { group_thread_id: groupId });
      log(
        'leave: a non-member cannot leave -> not_a_member',
        outsiderLeaves.status === 403 && outsiderLeaves.json?.error === 'not_a_member',
        JSON.stringify(outsiderLeaves.json),
      );

      const plainMemberLeaves = await callFunction(tokenPlainMember, { group_thread_id: groupId });
      log(
        'leave: a real (non-owner) member leaves -> 200',
        plainMemberLeaves.status === 200,
        JSON.stringify(plainMemberLeaves.json),
      );
    });

    const plainMemberStillMember = (
      await admin.query('select 1 from group_members where group_thread_id = $1 and user_id = $2', [
        groupId,
        plainMember,
      ])
    ).rowCount;
    log('plainMember really left group_members', plainMemberStillMember === 0);
  } finally {
    if (groupId) {
      await admin.query('delete from group_messages where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_members where group_thread_id = $1', [groupId]);
      await admin.query('delete from group_threads where id = $1', [groupId]);
    }
    await deleteTestUser(owner);
    await deleteTestUser(plainMember);
    await deleteTestUser(outsider);
    await deleteTestUser(joinable);
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
