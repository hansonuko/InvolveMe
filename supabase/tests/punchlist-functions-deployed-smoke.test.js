#!/usr/bin/env node
// Deployed-endpoint smoke test for the 9 functions found undeployed (8 of
// them) or possibly stale (post-status) during the 2026-09-18 punch-list
// audit — see docs/00-SESSION-HANDOFF.md. Every one of these had passed its
// own local `*-function.test.js` against the dev DB already; that only
// proves the code is correct, never that it was actually pushed to the live
// project (see this repo's own webhook-flutterwave incident). This is the
// check that would have caught `start-thread` returning "Requested function
// was not found" before a real user did.
//
// Each function gets one assertion that a real signed JWT reaches ITS OWN
// code (a real app-level response — success or a mapped business error —
// never a platform-level 404/401 gateway rejection), and, where relevant,
// one assertion that an unauthenticated request is still rejected. Business
// outcomes that need pre-existing state this script doesn't set up (a
// funded wallet, an existing thread) are allowed to come back as their
// expected app-level error (e.g. `insufficient_credit`) — the point is
// reachability + contract shape, not re-proving what the dev-DB tests
// already cover.

const crypto = require('crypto');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_INTERNAL_SECRET;

for (const [name, val] of Object.entries({
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_JWT_SECRET: JWT_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  CRON_INTERNAL_SECRET: CRON_SECRET,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:deployed\` from the repo root.`);
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

async function call(fn, token, body, method = 'POST') {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  const userAId = await createTestUser();
  const userBId = await createTestUser();
  const tokenA = mintAccessToken(userAId);

  // start-thread — the exact function item #6 reported as "Requested
  // function was not found." A real 200 with a thread_id proves this isn't
  // a platform 404 anymore, on the live project, not just locally.
  {
    const r = await call('start-thread', tokenA, { recipient_id: userBId });
    log(
      'deployed start-thread creates a real thread for an authenticated caller',
      r.status === 200 && typeof r.json?.thread_id === 'string',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
    const noAuth = await call('start-thread', null, { recipient_id: userBId });
    log('deployed start-thread rejects an unauthenticated request', noAuth.status === 401);
  }

  // create-status-upload-url — the function item #7's photo-status upload
  // needs. A real signed URL + token proves it reaches Storage correctly.
  {
    const r = await call('create-status-upload-url', tokenA, {});
    log(
      'deployed create-status-upload-url mints a real signed upload slot',
      r.status === 200 &&
        typeof r.json?.signed_url === 'string' &&
        r.json?.path?.startsWith(userAId),
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
    const noAuth = await call('create-status-upload-url', null, {});
    log(
      'deployed create-status-upload-url rejects an unauthenticated request',
      noAuth.status === 401,
    );
  }

  // post-status — redeployed to rule out a stale pre-Batch-F contract
  // (media_url -> media_path/text_style) being the "something went wrong"
  // item #7 also reported for a text-only post. A fresh test user has no
  // funded wallet, so the expected, meaningful outcome here is a real
  // 402 insufficient_credit from OUR OWN fn_post_status RPC — never a
  // platform 404, and never an "unmapped DB error" 500, which is what a
  // stale param signature would have produced instead.
  {
    const r = await call('post-status', tokenA, { caption: 'smoke test status' });
    log(
      'deployed post-status reaches fn_post_status with the current (media_path/text_style) contract',
      r.status === 402 && r.json?.error === 'insufficient_credit',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
  }

  // complete-onboarding
  {
    const r = await call('complete-onboarding', tokenA, {
      country: 'NG',
      display_name: 'Smoke Test',
      nickname: 'smoketest',
    });
    log(
      'deployed complete-onboarding resolves a real currency for a live country',
      r.status === 200 && r.json?.currency === 'NGN',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
  }

  // create-group-thread / send-group-message — added 2026-09-18 (punch-list
  // item 11, free group messaging). A real end-to-end pair: create a real
  // group with userB as a member, then send a real free message into it and
  // confirm it's actually free.
  let groupThreadId;
  {
    const r = await call('create-group-thread', tokenA, {
      name: 'Smoke Test Group',
      member_ids: [userBId],
    });
    log(
      'deployed create-group-thread creates a real group',
      r.status === 200 && typeof r.json?.group_thread_id === 'string',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
    groupThreadId = r.json?.group_thread_id;
  }
  {
    const r = await call('send-group-message', tokenA, {
      group_thread_id: groupThreadId,
      body: 'hello from the deployed smoke test',
    });
    log(
      'deployed send-group-message sends a real, genuinely free message',
      r.status === 200 && typeof r.json?.message_id === 'string' && r.json?.word_count === 6,
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
  }

  // mark-status-viewed — no real status exists for this random id, so the
  // meaningful assertion is "our own 404 status_not_found", not a platform
  // gateway rejection.
  {
    const r = await call('mark-status-viewed', tokenA, { status_id: crypto.randomUUID() });
    log(
      'deployed mark-status-viewed reaches fn_mark_status_viewed (404 status_not_found, not a platform error)',
      r.status === 404 && r.json?.error === 'status_not_found',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
  }

  // get-withdrawal-countdown
  {
    const r = await call('get-withdrawal-countdown', tokenA, undefined, 'GET');
    log(
      'deployed get-withdrawal-countdown returns real countdown fields',
      r.status === 200 && typeof r.json?.effective_sweep_hours === 'number',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
  }

  // set-thread-muted — no real thread for this random id, so the
  // meaningful assertion is our own 404, not a platform error.
  {
    const r = await call('set-thread-muted', tokenA, {
      thread_id: crypto.randomUUID(),
      muted: true,
    });
    log(
      'deployed set-thread-muted reaches fn_set_thread_muted (404 thread_not_found, not a platform error)',
      r.status === 404 && r.json?.error === 'thread_not_found',
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
  }

  // find-users-by-phones
  {
    const r = await call('find-users-by-phones', tokenA, { phones: ['2340000000000'] });
    log(
      'deployed find-users-by-phones returns a real matches array',
      r.status === 200 && Array.isArray(r.json?.matches),
      `status=${r.status} body=${JSON.stringify(r.json)}`,
    );
  }

  // remind-no-bank-account — server-to-server only, X-Cron-Secret auth
  // (verify_jwt intentionally OFF, same posture as reconcile-topups). The
  // meaningful check here is the opposite of every function above: a
  // request with NO cron secret must still be rejected, since verify_jwt
  // being off means the platform gateway itself won't do that job.
  {
    const noSecret = await fetch(`${SUPABASE_URL}/functions/v1/remind-no-bank-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    log(
      'deployed remind-no-bank-account rejects a request with no X-Cron-Secret (verify_jwt is off, so this is the only gate left)',
      noSecret.status === 401,
      `status=${noSecret.status}`,
    );
    const withSecret = await fetch(`${SUPABASE_URL}/functions/v1/remind-no-bank-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
    });
    log(
      'deployed remind-no-bank-account runs for real with the correct cron secret',
      withSecret.status === 200,
      `status=${withSecret.status}`,
    );
  }

  // group_threads.created_by/group_members.user_id have no ON DELETE
  // CASCADE to auth.users — deleting the test users below without cleaning
  // this up first would fail on a foreign-key violation, not silently
  // no-op. Via PostgREST with the service-role key (bypasses RLS the same
  // way the Edge Functions themselves do), same "no direct DB connection
  // in this HTTP-only smoke test" posture the rest of this file already has.
  if (groupThreadId) {
    const restHeaders = {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    };
    await fetch(`${SUPABASE_URL}/rest/v1/group_messages?group_thread_id=eq.${groupThreadId}`, {
      method: 'DELETE',
      headers: restHeaders,
    });
    await fetch(`${SUPABASE_URL}/rest/v1/group_members?group_thread_id=eq.${groupThreadId}`, {
      method: 'DELETE',
      headers: restHeaders,
    });
    await fetch(`${SUPABASE_URL}/rest/v1/group_threads?id=eq.${groupThreadId}`, {
      method: 'DELETE',
      headers: restHeaders,
    });
  }

  await deleteTestUser(userAId);
  await deleteTestUser(userBId);

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
