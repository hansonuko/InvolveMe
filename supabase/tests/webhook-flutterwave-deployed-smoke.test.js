#!/usr/bin/env node
// Deployed-endpoint smoke test for webhook-flutterwave — deliberately NOT
// the `deno run` local-harness pattern every other test in this suite
// uses. This exists because of a real incident (2026-09-13): every other
// test here spawns the function locally via `deno run` with env vars from
// `.env`, which proved the function's *code* was correct but never once
// exercised the function as actually deployed on Supabase's platform —
// and the deployed version was silently rejecting every real Flutterwave
// webhook with 401 UNAUTHORIZED_NO_AUTH_HEADER at the platform's own JWT
// gateway, before our code ever ran. 87/87 "passing" tests never caught
// this because none of them ever made an HTTP request to the real
// deployed URL. A real user's ₦100 top-up sat unconfirmed for over an
// hour as a direct result.
//
// This test hits the REAL deployed URL (EXPO_PUBLIC_SUPABASE_URL, not
// localhost) with a genuinely signed payload, and simply asserts the
// response is 200 — the platform-level gateway rejection (401
// UNAUTHORIZED_NO_AUTH_HEADER) and the runtime crash this incident
// actually involved (an unguarded global `Buffer` that Deno's local CLI
// tolerates but the deployed edge-runtime did not) both surface here,
// neither would in the local-harness suite.
//
// Requires webhook-flutterwave to have been deployed with
// `--no-verify-jwt` (see that function's own header comment) — if this
// test starts failing with 401 UNAUTHORIZED_NO_AUTH_HEADER, check that
// flag was included on the most recent deploy before assuming a code
// regression.

const crypto = require('crypto');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const WEBHOOK_SECRET = process.env.FLW_WEBHOOK_SECRET_HASH;

for (const [name, val] of Object.entries({
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  FLW_WEBHOOK_SECRET_HASH: WEBHOOK_SECRET,
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

function sign(rawBody) {
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('base64');
}

async function main() {
  const payload = {
    id: `wbk_deployed_smoke_${crypto.randomUUID()}`,
    timestamp: Date.now(),
    type: 'charge.completed',
    // A well-formed but nonexistent uuid reference — exercises the full
    // signature-verify -> claim -> route -> fn_confirm_topup path for
    // real without touching any real topup. fn_confirm_topup's own
    // "topup_not_found" is logged, not thrown, so this should still ack
    // 200 (per webhook-flutterwave's own documented behavior: a
    // malformed/stale reference doesn't fail the webhook delivery).
    data: {
      id: `chg_deployed_smoke_${crypto.randomUUID()}`,
      reference: '00000000-0000-0000-0000-000000000000',
      status: 'succeeded',
      amount: 1,
      currency: 'NGN',
    },
  };
  const rawBody = JSON.stringify(payload);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/webhook-flutterwave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'flutterwave-signature': sign(rawBody) },
    body: rawBody,
  });
  const text = await res.text();

  log(
    'deployed webhook-flutterwave accepts a real signed request (200, not the platform JWT gate or a runtime crash)',
    res.status === 200,
    `status=${res.status} body=${text.slice(0, 200)}`,
  );

  const badSig = await fetch(`${SUPABASE_URL}/functions/v1/webhook-flutterwave`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'flutterwave-signature': 'not-a-real-signature',
    },
    body: rawBody,
  });
  log(
    'deployed webhook-flutterwave still rejects a bad signature (401, not the platform gate blocking it earlier)',
    badSig.status === 401,
    `status=${badSig.status}`,
  );

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
