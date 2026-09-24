#!/usr/bin/env node
// Test for get-public-pricing — a read-only, no-balance-mutating function,
// so it's exempt from CLAUDE.md's ledger-conservation/concurrency test
// requirement (that requirement is scoped to balance-mutating functions).
// What matters here: no auth is required (it's a public marketing-site
// endpoint on purpose), and the response is exactly the 5 whitelisted
// pricing_config keys — no more (no accidental full-table leak), no less.

const { Client } = require('pg');
const { spawn } = require('node:child_process');
const path = require('node:path');

const DB_URL = process.env.SUPABASE_DB_URL;
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
})) {
  if (!val) {
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FUNCTION_ENTRY = path.join(__dirname, '..', 'functions', 'get-public-pricing', 'index.ts');
const EXPECTED_KEYS = [
  'credit_unit_kobo',
  'message_base_credits',
  'message_word_block_size',
  'message_max_words',
  'platform_topup_fee_bps',
].sort();

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
      await fetch(`${FUNCTION_URL}/`, { method: 'GET' });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('get-public-pricing function did not come up in time');
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

  try {
    await waitForFunctionReady(15000);

    const cfg = await admin.query(
      `select key, value from public.pricing_config where key = any($1)`,
      [EXPECTED_KEYS],
    );
    const expectedValues = Object.fromEntries(cfg.rows.map((r) => [r.key, Number(r.value)]));

    // No Authorization header at all — this must still succeed (200), the
    // opposite assertion from every auth-gated function's test in this
    // suite, since this one is deliberately public.
    const res = await fetch(`${FUNCTION_URL}/`, { method: 'GET' });
    const body = await res.json().catch(() => null);

    log(
      'no-auth request succeeds (200) — this endpoint is intentionally public',
      res.status === 200,
      `status=${res.status}`,
    );

    const returnedKeys = body ? Object.keys(body).sort() : [];
    log(
      'response contains exactly the 5 whitelisted keys, nothing else',
      JSON.stringify(returnedKeys) === JSON.stringify(EXPECTED_KEYS),
      `keys=${JSON.stringify(returnedKeys)}`,
    );

    log(
      'values match pricing_config exactly',
      body != null && EXPECTED_KEYS.every((k) => body[k] === expectedValues[k]),
      JSON.stringify(body),
    );

    const wrongMethod = await fetch(`${FUNCTION_URL}/`, { method: 'POST' });
    log('POST is rejected (405)', wrongMethod.status === 405, `status=${wrongMethod.status}`);
  } finally {
    deno.kill();
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
