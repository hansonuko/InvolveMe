#!/usr/bin/env node
// Deployed-endpoint smoke test for reconcile-topups — same rationale as
// webhook-flutterwave-deployed-smoke.test.js (that file's header has the
// full incident this pattern exists to catch): every other test in this
// suite spawns the function locally via `deno run`, which proves the code
// is correct but never once proves the function as actually deployed on
// Supabase's platform behaves the same way. In particular: this function
// MUST be deployed with `--no-verify-jwt` (see its own header comment for
// why), and the whole point of reconcile-topups existing is to not repeat
// "the deployed version silently rejects everything and nobody notices
// for weeks" a second time, this time for the fix itself rather than the
// original bug.
//
// Hits the REAL deployed URL (EXPO_PUBLIC_SUPABASE_URL) with the real
// CRON_INTERNAL_SECRET this project's `.env`/Vault/function-secrets all
// share (see .env.example) — not a local re-implementation of the check.

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const CRON_SECRET = process.env.CRON_INTERNAL_SECRET;

for (const [name, val] of Object.entries({
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
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

async function main() {
  const withSecret = await fetch(`${SUPABASE_URL}/functions/v1/reconcile-topups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': CRON_SECRET },
    body: '{}',
  });
  const withSecretJson = await withSecret.json().catch(() => null);
  log(
    'deployed reconcile-topups accepts the real X-Cron-Secret (200, not the platform JWT gate)',
    withSecret.status === 200 &&
      typeof withSecretJson?.checked === 'number' &&
      typeof withSecretJson?.confirmed === 'number',
    `status=${withSecret.status} body=${JSON.stringify(withSecretJson)}`,
  );

  const noSecret = await fetch(`${SUPABASE_URL}/functions/v1/reconcile-topups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const noSecretJson = await noSecret.json().catch(() => null);
  log(
    'deployed reconcile-topups still rejects a missing secret with OUR OWN 401 (unauthorized), not a bare platform gateway rejection',
    noSecret.status === 401 && noSecretJson?.error === 'unauthorized',
    `status=${noSecret.status} body=${JSON.stringify(noSecretJson)}`,
  );

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
