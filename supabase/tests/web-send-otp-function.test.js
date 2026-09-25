#!/usr/bin/env node
// Test for web-send-otp — the marketing site's OTP-send proxy
// (docs/15-MARKETING-SITE-PWA-SCOPING.md §4). No balance mutation, so
// exempt from CLAUDE.md's ledger-conservation/concurrency requirement.
//
// Uses Cloudflare's own published Turnstile TEST secret keys
// (https://developers.cloudflare.com/turnstile/troubleshooting/testing/),
// injected only into this local Deno subprocess's env — never set as the
// real deployed secret (see web-send-otp-deployed-smoke.test.js, which
// asserts the opposite: that production is NOT configured with these).
//
// The final "captcha passes" case intentionally does not assert a 200 —
// once past the captcha gate this function proxies to Supabase's real
// /auth/v1/otp, and this project's real SMS provider (Termii) isn't wired
// up yet (docs/00-SESSION-HANDOFF.md), so GoTrue itself may legitimately
// reject the send. What this test proves is narrower and still
// meaningful: a valid captcha genuinely reaches the GoTrue proxy step
// (response is not one of this function's own captcha-stage errors).

const { spawn } = require('node:child_process');
const path = require('node:path');

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

for (const [name, val] of Object.entries({
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

// Cloudflare's published, public test constants — not secrets.
const TURNSTILE_TEST_SECRET_ALWAYS_PASSES = '1x0000000000000000000000000000000AA';
const TURNSTILE_TEST_SECRET_ALWAYS_FAILS = '2x0000000000000000000000000000000AA';
const TEST_PHONE = '+2348012345678';

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'web-send-otp', 'index.ts');

let pass = 0;
let fail = 0;
function log(label, ok, detail) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

async function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${FUNCTION_URL}/`, { method: 'OPTIONS' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('web-send-otp function did not come up in time');
}

function spawnFunction(extraEnv) {
  const deno = spawn('deno', ['run', '-A', FUNCTION_ENTRY], {
    env: { ...process.env, SUPABASE_URL, SUPABASE_ANON_KEY: ANON_KEY, ...extraEnv },
  });
  deno.stdout.on('data', (d) => process.stdout.write(`[deno] ${d}`));
  deno.stderr.on('data', (d) => process.stderr.write(`[deno] ${d}`));
  return deno;
}

async function call(body) {
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  // --- Phase 1: TURNSTILE_SECRET_KEY not set at all -> fails closed ---
  let deno = spawnFunction({});
  try {
    await waitForFunctionReady(15000);

    const missingPhone = await call({ turnstileToken: 'anything' });
    log(
      'missing/invalid phone -> 400 invalid_phone',
      missingPhone.status === 400 && missingPhone.json?.error === 'invalid_phone',
      JSON.stringify(missingPhone),
    );

    const missingToken = await call({ phone: TEST_PHONE });
    log(
      'missing turnstileToken -> 400 missing_captcha',
      missingToken.status === 400 && missingToken.json?.error === 'missing_captcha',
      JSON.stringify(missingToken),
    );

    const noSecretConfigured = await call({ phone: TEST_PHONE, turnstileToken: 'whatever' });
    log(
      'TURNSTILE_SECRET_KEY unset -> fails CLOSED (503 captcha_not_configured), not silently open',
      noSecretConfigured.status === 503 &&
        noSecretConfigured.json?.error === 'captcha_not_configured',
      JSON.stringify(noSecretConfigured),
    );
  } finally {
    deno.kill();
  }

  // --- Phase 2: real secret configured, bad token -> captcha_failed ---
  deno = spawnFunction({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_ALWAYS_FAILS });
  try {
    await waitForFunctionReady(15000);

    const badToken = await call({ phone: TEST_PHONE, turnstileToken: 'bogus-token' });
    log(
      'invalid captcha token -> 400 captcha_failed',
      badToken.status === 400 && badToken.json?.error === 'captcha_failed',
      JSON.stringify(badToken),
    );
  } finally {
    deno.kill();
  }

  // --- Phase 3: real secret configured, always-passing token -> reaches GoTrue proxy step ---
  deno = spawnFunction({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRET_ALWAYS_PASSES });
  try {
    await waitForFunctionReady(15000);

    const goodToken = await call({ phone: TEST_PHONE, turnstileToken: 'any-token-accepted' });
    const captchaStageErrors = ['missing_captcha', 'captcha_failed', 'captcha_not_configured'];
    log(
      'valid captcha reaches the GoTrue proxy step (not rejected at the captcha stage)',
      !captchaStageErrors.includes(goodToken.json?.error),
      JSON.stringify(goodToken),
    );
  } finally {
    deno.kill();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
