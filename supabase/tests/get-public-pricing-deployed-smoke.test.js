#!/usr/bin/env node
// Deployed-endpoint smoke test for get-public-pricing — same rationale as
// webhook-flutterwave-deployed-smoke.test.js and
// reconcile-topups-deployed-smoke.test.js: a local `deno run` test proves
// the function's own code is correct but never proves the *deployed*
// version is actually reachable at its real URL with the right JWT-gateway
// posture. This project has hit that exact gap in prod before (see
// webhook-flutterwave/index.ts's header for the 2026-09-13 incident).
//
// Requires get-public-pricing to have been deployed with `--no-verify-jwt`
// (see that function's own header comment) — if this test starts failing
// with 401 UNAUTHORIZED_NO_AUTH_HEADER, check that flag was included on
// the most recent deploy before assuming a code regression.

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;

if (!SUPABASE_URL) {
  console.error(
    'EXPO_PUBLIC_SUPABASE_URL is not set. Run via `npm run test:deployed` from the repo root.',
  );
  process.exit(1);
}

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

async function main() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/get-public-pricing`, { method: 'GET' });
  const body = await res.json().catch(() => null);

  log(
    'deployed get-public-pricing answers a request with NO Authorization header at all (200, not a platform 401 gateway rejection)',
    res.status === 200,
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  const returnedKeys = body ? Object.keys(body).sort() : [];
  log(
    'response contains exactly the 5 whitelisted keys',
    JSON.stringify(returnedKeys) === JSON.stringify(EXPECTED_KEYS),
    `keys=${JSON.stringify(returnedKeys)}`,
  );

  log(
    'credit_unit_kobo is a positive number (sanity check, not a full value assertion — real value belongs to ops)',
    typeof body?.credit_unit_kobo === 'number' && body.credit_unit_kobo > 0,
    `credit_unit_kobo=${body?.credit_unit_kobo}`,
  );

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e);
  process.exit(1);
});
