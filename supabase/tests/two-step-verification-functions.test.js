#!/usr/bin/env node
// End-to-end lifecycle test of the five two-step-verification Edge
// Functions (set-two-step-pin, verify-two-step-pin, disable-two-step,
// request-two-step-reset, complete-two-step-reset) against the real
// linked dev database. Each function is its own tiny Deno process
// listening on the same port, spawned and killed in sequence as the
// lifecycle moves between them — unlike this repo's other multi-function
// suites, these five genuinely share mutable state (one user's lockout
// counters and PIN hash) across the whole flow, so testing them as one
// ordered story is what actually proves the feature works end to end,
// not just that each endpoint responds in isolation.

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
    console.error(`${name} is not set. Run via \`npm run test:functions\` from the repo root.`);
    process.exit(1);
  }
}

const FUNCTION_URL = 'http://127.0.0.1:8000';
const FN_DIR = path.join(__dirname, '..', 'functions');

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

function waitForFunctionReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    while (Date.now() < deadline) {
      try {
        await fetch(`${FUNCTION_URL}/`, { method: 'POST', body: '{}' });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error('function did not come up in time');
  })();
}

/** Spawns one function for the duration of `action`, then always kills it
 * — this is what lets five functions share port 8000 in one test run
 * without conflicting, since only one is ever actually listening. */
async function withFunction(name, action) {
  const entry = path.join(FN_DIR, name, 'index.ts');
  const deno = spawn('deno', ['run', '-A', entry], {
    env: {
      ...process.env,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    },
  });
  deno.stderr.on('data', (d) => process.stderr.write(`[deno:${name}] ${d}`));
  try {
    await waitForFunctionReady(15000);
    return await action();
  } finally {
    deno.kill();
    // A moment for the port to actually free before the next function
    // tries to bind it — spawn/kill alone isn't always instant.
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function call(token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${FUNCTION_URL}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function main() {
  const admin = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  admin.on('error', (e) => process.stderr.write(`[connection error, non-fatal] ${e.message}\n`));
  await admin.connect();

  const userId = await createTestUser();
  const token = mintAccessToken(userId);

  try {
    // --- First-time setup ---
    await withFunction('set-two-step-pin', async () => {
      const noAuth = await call(null, { pin: '123456' });
      log('set-two-step-pin: missing auth -> 401', noAuth.status === 401);

      const badFormat = await call(token, { pin: '12ab' });
      log(
        'set-two-step-pin: non-6-digit pin -> 400 invalid_pin',
        badFormat.status === 400 && badFormat.json?.error === 'invalid_pin',
      );

      const first = await call(token, { pin: '123456', recovery_email: 'user@example.com' });
      log(
        'set-two-step-pin: first-time setup succeeds with no current_pin',
        first.status === 200,
        JSON.stringify(first.json),
      );
    });

    const afterSetup = (
      await admin.query(
        'select two_step_enabled, two_step_pin_hash, two_step_recovery_email from users where id = $1',
        [userId],
      )
    ).rows[0];
    log(
      'DB reflects enabled=true, a real hash (never the raw PIN), and the recovery email',
      afterSetup.two_step_enabled === true &&
        typeof afterSetup.two_step_pin_hash === 'string' &&
        afterSetup.two_step_pin_hash !== '123456' &&
        afterSetup.two_step_recovery_email === 'user@example.com',
      JSON.stringify(afterSetup),
    );

    // --- Lockout: 5 wrong attempts locks, 6th is rejected outright ---
    await withFunction('verify-two-step-pin', async () => {
      let lastLocked = null;
      for (let i = 0; i < 5; i++) {
        const r = await call(token, { pin: '000000' });
        if (r.json?.locked_until) lastLocked = r.json.locked_until;
      }
      log(
        'verify-two-step-pin: 5 wrong attempts triggers a lockout',
        !!lastLocked,
        `locked_until=${lastLocked}`,
      );

      const sixth = await call(token, { pin: '123456' }); // even the CORRECT pin, while locked
      log(
        'verify-two-step-pin: locked out even with the correct PIN -> 429',
        sixth.status === 429 && sixth.json?.error === 'too_many_attempts',
        JSON.stringify(sixth.json),
      );
    });

    // Clear the lockout directly (this test isn't going to wait 15 real
    // minutes) so the rest of the lifecycle can proceed.
    await admin.query(
      'update users set two_step_failed_attempts = 0, two_step_locked_until = null where id = $1',
      [userId],
    );

    await withFunction('verify-two-step-pin', async () => {
      const wrong = await call(token, { pin: '999999' });
      log(
        'verify-two-step-pin: a single wrong attempt (post-lockout-clear) -> verified false, not yet locked',
        wrong.status === 200 && wrong.json?.verified === false && !wrong.json?.locked_until,
        JSON.stringify(wrong.json),
      );

      const right = await call(token, { pin: '123456' });
      log(
        'verify-two-step-pin: correct PIN -> verified true',
        right.status === 200 && right.json?.verified === true,
      );
    });

    const afterVerify = (
      await admin.query('select two_step_failed_attempts from users where id = $1', [userId])
    ).rows[0];
    log(
      'a successful verify resets the failed-attempts counter',
      afterVerify.two_step_failed_attempts === 0,
    );

    // --- Changing the PIN requires the current one ---
    await withFunction('set-two-step-pin', async () => {
      const noCurrentPin = await call(token, { pin: '654321' });
      log(
        'set-two-step-pin: changing an existing PIN without current_pin -> 400',
        noCurrentPin.status === 400 && noCurrentPin.json?.error === 'invalid_request',
      );

      const wrongCurrentPin = await call(token, { pin: '654321', current_pin: '000000' });
      log(
        'set-two-step-pin: wrong current_pin -> 403 incorrect_pin',
        wrongCurrentPin.status === 403 && wrongCurrentPin.json?.error === 'incorrect_pin',
      );

      const changed = await call(token, { pin: '654321', current_pin: '123456' });
      log('set-two-step-pin: correct current_pin allows the change', changed.status === 200);
    });

    // --- Disabling also requires the current (now new) PIN ---
    await withFunction('disable-two-step', async () => {
      const wrong = await call(token, { current_pin: '123456' }); // the OLD pin, no longer valid
      log(
        'disable-two-step: stale current_pin rejected -> 403',
        wrong.status === 403 && wrong.json?.error === 'incorrect_pin',
      );

      const right = await call(token, { current_pin: '654321' });
      log('disable-two-step: correct current PIN disables it', right.status === 200);
    });

    const afterDisable = (
      await admin.query('select two_step_enabled, two_step_pin_hash from users where id = $1', [
        userId,
      ])
    ).rows[0];
    log(
      'DB reflects fully disabled: enabled=false, hash cleared',
      afterDisable.two_step_enabled === false && afterDisable.two_step_pin_hash === null,
      JSON.stringify(afterDisable),
    );

    // --- Forgot-PIN cooldown path: re-enable, then walk the reset flow ---
    await withFunction('set-two-step-pin', async () => {
      const reenable = await call(token, { pin: '111222' });
      log(
        'set-two-step-pin: re-enabling after a disable works like first-time setup',
        reenable.status === 200,
      );
    });

    await withFunction('complete-two-step-reset', async () => {
      const tooEarly = await call(token, {});
      log(
        'complete-two-step-reset: no reset requested yet -> 400 no_reset_requested',
        tooEarly.status === 400 && tooEarly.json?.error === 'no_reset_requested',
      );
    });

    let firstRequestedAt;
    await withFunction('request-two-step-reset', async () => {
      const r1 = await call(token, {});
      log(
        'request-two-step-reset: starts the cooldown',
        r1.status === 200 && !!r1.json?.requested_at,
      );
      firstRequestedAt = r1.json?.requested_at;

      const r2 = await call(token, {});
      log(
        'request-two-step-reset: calling again does not push the clock back out (idempotent)',
        // Same instant, not necessarily the same string — the first
        // response is a freshly-constructed ISO string (`...Z`) from the
        // Edge Function; the second reads the already-stored value back
        // through Postgres/PostgREST, which renders it as `...+00:00`.
        r2.status === 200 &&
          new Date(r2.json?.requested_at).getTime() === new Date(firstRequestedAt).getTime(),
        `first=${firstRequestedAt} second=${r2.json?.requested_at}`,
      );
    });

    await withFunction('complete-two-step-reset', async () => {
      const tooEarly = await call(token, {});
      log(
        'complete-two-step-reset: cooldown not elapsed yet -> 403 cooldown_not_elapsed',
        tooEarly.status === 403 && tooEarly.json?.error === 'cooldown_not_elapsed',
        JSON.stringify(tooEarly.json),
      );
    });

    // Backdate the request past the cooldown window directly — this test
    // isn't going to wait 7 real days either.
    await admin.query(
      `update users set two_step_reset_requested_at = now() - interval '8 days' where id = $1`,
      [userId],
    );

    await withFunction('complete-two-step-reset', async () => {
      const now = await call(token, {});
      log(
        'complete-two-step-reset: succeeds once the cooldown has genuinely elapsed',
        now.status === 200,
        JSON.stringify(now.json),
      );
    });

    const afterReset = (
      await admin.query(
        'select two_step_enabled, two_step_pin_hash, two_step_reset_requested_at from users where id = $1',
        [userId],
      )
    ).rows[0];
    log(
      'DB reflects a full reset: disabled, hash and pending-reset timestamp both cleared',
      afterReset.two_step_enabled === false &&
        afterReset.two_step_pin_hash === null &&
        afterReset.two_step_reset_requested_at === null,
      JSON.stringify(afterReset),
    );
  } finally {
    await deleteTestUser(userId);
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
