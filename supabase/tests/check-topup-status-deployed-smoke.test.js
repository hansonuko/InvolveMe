#!/usr/bin/env node
// Deployed-endpoint smoke test for check-topup-status — same rationale as
// webhook-flutterwave-deployed-smoke.test.js. This function stays
// verify_jwt ON (default), which is the opposite failure mode from
// reconcile-topups/webhook-flutterwave: if a future deploy ever
// accidentally adds `--no-verify-jwt` here, this test is what would catch
// an unauthenticated request no longer being rejected by the platform
// gateway before this file's own ownership check even runs.

const crypto = require('crypto');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

for (const [name, val] of Object.entries({
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_JWT_SECRET: JWT_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
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
  // supabase.auth.getUser() (what requireAuthenticatedUser calls) validates
  // against a real session/user, not just the JWT signature — a token
  // minted for a random id with no auth.users row is correctly rejected as
  // "Invalid or expired token", which would make this test's main
  // assertion fail for a reason that has nothing to do with the deployed
  // function's own correctness. A real (throwaway, cleaned up below) user
  // is what makes that assertion mean something.
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

async function main() {
  const userId = await createTestUser();
  const token = mintAccessToken(userId);

  const authed = await fetch(`${SUPABASE_URL}/functions/v1/check-topup-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ topup_id: crypto.randomUUID() }),
  });
  const authedJson = await authed.json().catch(() => null);
  log(
    'deployed check-topup-status accepts a real signed JWT and runs OUR OWN not-found check (404 topup_not_found, not a platform-level rejection)',
    authed.status === 404 && authedJson?.error === 'topup_not_found',
    `status=${authed.status} body=${JSON.stringify(authedJson)}`,
  );

  const noAuth = await fetch(`${SUPABASE_URL}/functions/v1/check-topup-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topup_id: crypto.randomUUID() }),
  });
  log(
    // Can't cleanly distinguish "the platform gateway rejected this" from
    // "our own requireAuthenticatedUser rejected this" from the outside —
    // both correctly return 401 whether verify_jwt is on or off. What this
    // does prove: SOMETHING still rejects an unauthenticated request,
    // which combined with the authed assertion above (a real signed JWT
    // reaches this file's own ownership-check code, not a platform error
    // body) is enough to know this endpoint hasn't quietly gone fully open.
    'deployed check-topup-status still rejects a request with no Authorization at all (401)',
    noAuth.status === 401,
    `status=${noAuth.status}`,
  );

  await deleteTestUser(userId);

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
