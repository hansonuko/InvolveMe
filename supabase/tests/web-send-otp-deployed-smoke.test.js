#!/usr/bin/env node
// Deployed-endpoint smoke test for web-send-otp — same rationale as this
// suite's other *-deployed-smoke tests (see webhook-flutterwave's for the
// full 2026-09-13 incident that makes local-only tests insufficient proof
// a public Edge Function is actually reachable).
//
// Requires web-send-otp to have been deployed with `--no-verify-jwt` (see
// that function's own header comment).
//
// This test deliberately does NOT configure a real Turnstile secret and
// asserts the function correctly fails CLOSED in production today — real
// Cloudflare credentials are a external-service dependency the user hasn't
// set up yet. If this test starts asserting a 200 "sent" response instead,
// that's a signal TURNSTILE_SECRET_KEY has been configured in production —
// update this test deliberately at that point, don't just relax it.

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

if (!SUPABASE_URL) {
  console.error(
    'EXPO_PUBLIC_SUPABASE_URL is not set. Run via `npm run test:deployed` from the repo root.',
  );
  process.exit(1);
}

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

async function main() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/web-send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://involveme.com' },
    // Unique per run for the same reason as web-send-otp-function.test.js:
    // this assertion needs the request to get PAST the per-phone rate
    // limiter to reach the captcha check, so a number shared with any other
    // run in the same 10-minute window turns a captcha assertion into a 429.
    body: JSON.stringify({
      phone: `+234${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      turnstileToken: 'irrelevant',
    }),
  });
  const body = await res.json().catch(() => null);

  log(
    'deployed web-send-otp answers a request with NO Authorization header at all (not a platform 401 gateway rejection)',
    res.status !== 401 || body?.error !== undefined,
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  log(
    'fails CLOSED in production today — no TURNSTILE_SECRET_KEY configured yet (503 captcha_not_configured), not a silent bypass',
    res.status === 503 && body?.error === 'captcha_not_configured',
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  log(
    'CORS header reflects an allowed Origin',
    res.headers.get('access-control-allow-origin') === 'https://involveme.com',
    `access-control-allow-origin=${res.headers.get('access-control-allow-origin')}`,
  );

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
