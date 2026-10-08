#!/usr/bin/env node
// Deployed-endpoint smoke test for web-send-otp — same rationale as this
// suite's other *-deployed-smoke tests (see webhook-flutterwave's for the
// full 2026-09-13 incident that makes local-only tests insufficient proof
// a public Edge Function is actually reachable).
//
// Requires web-send-otp to have been deployed with `--no-verify-jwt` (see
// that function's own header comment).
//
// A real Turnstile widget + TURNSTILE_SECRET_KEY went live in production
// 2026-10-08 (session 41) — per this file's own prior instruction ("if
// this test starts asserting a 200 'sent' response instead... update this
// test deliberately, don't just relax it"), updated deliberately rather
// than left asserting the old pre-Cloudflare-account fail-closed state.
// This now asserts the REAL check runs: a bogus token reaches Cloudflare's
// siteverify and is correctly rejected (400 captcha_failed), not that
// captcha is unconfigured. It does NOT assert a 200 "sent" response — this
// test has no way to produce a real, human-verified Turnstile token, so
// "the check genuinely rejects a fake token" is the correct, strongest
// claim an automated smoke test can make here.

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
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://involveme-marketing.pages.dev',
    },
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
    'the real Turnstile check runs in production — a bogus token is genuinely rejected (400 captcha_failed), not silently accepted or stuck fail-closed-unconfigured (503)',
    res.status === 400 && body?.error === 'captcha_failed',
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  log(
    'CORS header reflects an allowed Origin',
    res.headers.get('access-control-allow-origin') === 'https://involveme-marketing.pages.dev',
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
