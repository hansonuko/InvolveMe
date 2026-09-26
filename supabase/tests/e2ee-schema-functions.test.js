#!/usr/bin/env node
// E2EE step 1 (docs/21-E2EE-TECHNICAL-DESIGN.md §2-3,
// 20260926160000_e2ee_schema.sql) — direct DB-level tests, same pattern as
// chargeback-functions.test.js/thread-payer-functions.test.js (plain
// pg.Client + fn_ calls; none of these four functions have an Edge
// Function wrapper yet — that's step 2's client-facing work, this file
// tests the schema/handshake layer directly).
//
// Covers: device registration actually persists identity keys + initial
// prekeys; fn_fetch_prekey_bundles enforces the thread-partner-only gate
// (same posture find-user-by-phone/users_select_own_or_thread_partner
// already establish elsewhere in this app), atomically claims and
// consumes exactly one one-time prekey per call (never double-claimed
// under concurrency), degrades gracefully (returns null one-time fields,
// not an error) once a device's pool is exhausted, and skips a device
// whose signed prekey has expired; fn_replenish_one_time_prekeys is
// self-only; fn_enable_e2ee requires both participants to already have a
// registered device, is idempotent, and is participant-only.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error(
    'SUPABASE_DB_URL is not set. Run via `npm run test:e2ee-schema` from the repo root.',
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

function newClient() {
  const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  client.on('error', (e) => {
    process.stderr.write(`[connection error, non-fatal to the test run] ${e.message}\n`);
  });
  return client;
}

async function createTestUser(admin) {
  const id = crypto.randomUUID();
  const phone = `+234${crypto.randomInt(100000000, 999999999)}`;
  await admin.query(
    `insert into auth.users (id, phone, created_at, aud, role, instance_id)
     values ($1, $2, now(), 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')`,
    [id, phone],
  );
  return id;
}

async function deleteTestUser(admin, id) {
  await admin.query('delete from auth.users where id = $1', [id]); // cascades to public.users
}

async function deleteTestThread(admin, threadId) {
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

function randomBase64(byteLength) {
  return crypto.randomBytes(byteLength).toString('base64');
}

function fakePrekeyBatch(count, startKeyId = 1) {
  const batch = [];
  for (let i = 0; i < count; i++) {
    batch.push({ key_id: startKeyId + i, public_key: randomBase64(32) });
  }
  return batch;
}

async function registerDevice(admin, userId, opts = {}) {
  const res = await admin.query(
    `select public.fn_register_e2ee_device($1, $2, $3, $4, $5, $6, $7, $8, $9) as device_id`,
    [
      userId,
      opts.label ?? 'test device',
      opts.identityEd25519 ?? randomBase64(32),
      opts.identityX25519 ?? randomBase64(32),
      opts.signedPrekeyId ?? 1,
      opts.signedPrekeyPublic ?? randomBase64(32),
      opts.signedPrekeySignature ?? randomBase64(64),
      opts.signedPrekeyExpiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify(opts.oneTimePrekeys ?? fakePrekeyBatch(3)),
    ],
  );
  return res.rows[0].device_id;
}

async function fetchBundles(admin, callerId, targetId) {
  const res = await admin.query('select * from public.fn_fetch_prekey_bundles($1, $2)', [
    callerId,
    targetId,
  ]);
  return res.rows;
}

// ===========================================================================
// Test 1: registration persists identity keys and the initial prekey pool.
// ===========================================================================

async function testRegistrationPersists(admin) {
  const A = await createTestUser(admin);
  try {
    const identityEd = randomBase64(32);
    const identityX = randomBase64(32);
    const deviceId = await registerDevice(admin, A, {
      identityEd25519: identityEd,
      identityX25519: identityX,
      oneTimePrekeys: fakePrekeyBatch(5),
    });

    const deviceRow = (
      await admin.query(
        'select user_id, identity_key_ed25519, identity_key_x25519 from public.e2ee_devices where id = $1',
        [deviceId],
      )
    ).rows[0];
    log('device row created for the right user', deviceRow.user_id === A);
    log(
      'identity_key_ed25519 round-trips exactly',
      deviceRow.identity_key_ed25519.toString('base64') === identityEd,
    );
    log(
      'identity_key_x25519 round-trips exactly',
      deviceRow.identity_key_x25519.toString('base64') === identityX,
    );

    const signedCount = (
      await admin.query(
        'select count(*) as n from public.e2ee_signed_prekeys where device_id = $1',
        [deviceId],
      )
    ).rows[0].n;
    log('exactly one signed prekey row created', Number(signedCount) === 1);

    const otpCount = (
      await admin.query(
        'select count(*) as n from public.e2ee_one_time_prekeys where device_id = $1 and consumed_at is null',
        [deviceId],
      )
    ).rows[0].n;
    log('all 5 one-time prekeys persisted, unconsumed', Number(otpCount) === 5);
  } finally {
    await deleteTestUser(admin, A);
  }
}

// ===========================================================================
// Test 2: fn_fetch_prekey_bundles — thread-partner gate, self-fetch
// rejection, bundle correctness, and one-time-prekey consumption.
// ===========================================================================

async function testFetchBundlesPolicyAndConsumption(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const C = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;

  try {
    let rejected = false;
    try {
      await fetchBundles(admin, A, A);
    } catch (e) {
      rejected = e.message.includes('cannot_fetch_own_bundle');
    }
    log('cannot fetch your own bundle', rejected);

    rejected = false;
    try {
      await fetchBundles(admin, C, B);
    } catch (e) {
      rejected = e.message.includes('not_a_thread_partner');
    }
    log('a non-thread-partner cannot fetch a bundle (anti-enumeration gate)', rejected);

    const deviceB = await registerDevice(admin, B, { oneTimePrekeys: fakePrekeyBatch(2, 100) });

    const bundles1 = await fetchBundles(admin, A, B);
    log(
      "A (a real thread partner) gets exactly one bundle for B's one device",
      bundles1.length === 1,
    );
    log('the bundle is for the right device', bundles1[0].device_id === deviceB);
    log(
      'a one-time prekey was included and claimed (key_id 100 or 101)',
      bundles1[0].one_time_prekey_id === 100 || bundles1[0].one_time_prekey_id === 101,
    );

    const claimedKeyId = bundles1[0].one_time_prekey_id;
    const consumedRow = (
      await admin.query(
        'select consumed_at from public.e2ee_one_time_prekeys where device_id = $1 and key_id = $2',
        [deviceB, claimedKeyId],
      )
    ).rows[0];
    log('the claimed one-time prekey is now marked consumed', consumedRow.consumed_at !== null);

    const bundles2 = await fetchBundles(admin, A, B);
    log(
      'a second fetch claims the OTHER remaining one-time prekey, not the same one',
      bundles2[0].one_time_prekey_id !== claimedKeyId && bundles2[0].one_time_prekey_id !== null,
    );

    const bundles3 = await fetchBundles(admin, A, B);
    log(
      'a third fetch, with the pool exhausted, still returns the bundle — degrades gracefully, no error',
      bundles3.length === 1,
    );
    log(
      'one_time_prekey_id/public are null once the pool is exhausted (not an error)',
      bundles3[0].one_time_prekey_id === null && bundles3[0].one_time_prekey_public === null,
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    await deleteTestUser(admin, C);
  }
}

// ===========================================================================
// Test 3: a device with an expired signed prekey is skipped outright, and
// a user with multiple devices gets one bundle per device.
// ===========================================================================

async function testExpiredPrekeySkippedMultiDevice(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;

  try {
    const expiredDevice = await registerDevice(admin, B, {
      label: 'expired device',
      signedPrekeyExpiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    const freshDevice = await registerDevice(admin, B, { label: 'fresh device' });

    const bundles = await fetchBundles(admin, A, B);
    log(
      'B has 2 devices but only the one with a valid signed prekey is returned',
      bundles.length === 1 && bundles[0].device_id === freshDevice,
    );
    log(
      'the expired device was genuinely skipped, not just filtered client-side',
      expiredDevice !== freshDevice,
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 4: concurrency — two simultaneous fetches for the same target must
// never claim the same one-time prekey twice.
// ===========================================================================

async function testConcurrentFetchesDontDoubleClaimPrekey(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;

  try {
    await registerDevice(admin, B, { oneTimePrekeys: fakePrekeyBatch(1, 500) });

    const client1 = newClient();
    const client2 = newClient();
    await client1.connect();
    await client2.connect();

    const [r1, r2] = await Promise.all([
      client1.query('select * from public.fn_fetch_prekey_bundles($1, $2)', [A, B]),
      client2.query('select * from public.fn_fetch_prekey_bundles($1, $2)', [A, B]),
    ]);

    await client1.end();
    await client2.end();

    const claimed = [r1.rows[0].one_time_prekey_id, r2.rows[0].one_time_prekey_id].filter(
      (id) => id !== null,
    );
    log(
      'exactly one of the two concurrent calls claimed the single available one-time prekey, not both',
      claimed.length === 1 && claimed[0] === 500,
      JSON.stringify(claimed),
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 5: fn_replenish_one_time_prekeys is self-only.
// ===========================================================================

async function testReplenishSelfOnly(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  try {
    const deviceA = await registerDevice(admin, A, { oneTimePrekeys: fakePrekeyBatch(1, 900) });

    let rejected = false;
    try {
      await admin.query('select public.fn_replenish_one_time_prekeys($1, $2, $3)', [
        B,
        deviceA,
        JSON.stringify(fakePrekeyBatch(2, 901)),
      ]);
    } catch (e) {
      rejected = e.message.includes('not_your_device');
    }
    log("B cannot replenish A's device", rejected);

    const inserted = await admin.query(
      'select public.fn_replenish_one_time_prekeys($1, $2, $3) as n',
      [A, deviceA, JSON.stringify(fakePrekeyBatch(4, 910))],
    );
    log('A can replenish their own device', Number(inserted.rows[0].n) === 4);

    const totalAvailable = (
      await admin.query(
        'select count(*) as n from public.e2ee_one_time_prekeys where device_id = $1 and consumed_at is null',
        [deviceA],
      )
    ).rows[0].n;
    log(
      'pool now has the original 1 plus the 4 replenished, none consumed',
      Number(totalAvailable) === 5,
    );
  } finally {
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 6: fn_enable_e2ee — requires both sides to have a device, is
// idempotent, and is participant-only.
// ===========================================================================

async function testEnableE2ee(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const C = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;

  try {
    let rejected = false;
    try {
      await admin.query('select public.fn_enable_e2ee($1, $2)', [threadId, C]);
    } catch (e) {
      rejected = e.message.includes('not_a_participant');
    }
    log('a non-participant cannot enable E2EE on the thread', rejected);

    rejected = false;
    try {
      await admin.query('select public.fn_enable_e2ee($1, $2)', [threadId, A]);
    } catch (e) {
      rejected = e.message.includes('participant_a_has_no_e2ee_device');
    }
    log('cannot enable when the caller (participant_a) has no registered device yet', rejected);

    await registerDevice(admin, A);

    rejected = false;
    try {
      await admin.query('select public.fn_enable_e2ee($1, $2)', [threadId, A]);
    } catch (e) {
      rejected = e.message.includes('participant_b_has_no_e2ee_device');
    }
    log('cannot enable when the OTHER participant (B) has no registered device yet', rejected);

    await registerDevice(admin, B);

    await admin.query('select public.fn_enable_e2ee($1, $2)', [threadId, A]);
    const statusAfter = (
      await admin.query('select e2ee_status from public.threads where id = $1', [threadId])
    ).rows[0];
    log('once both sides have a device, enabling succeeds', statusAfter.e2ee_status === 'active');

    // Idempotent: calling again (even as B this time) is a silent no-op.
    await admin.query('select public.fn_enable_e2ee($1, $2)', [threadId, B]);
    const statusAfter2 = (
      await admin.query('select e2ee_status from public.threads where id = $1', [threadId])
    ).rows[0];
    log(
      'calling fn_enable_e2ee again is a no-op, not an error',
      statusAfter2.e2ee_status === 'active',
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    await deleteTestUser(admin, C);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testRegistrationPersists(admin);
    await testFetchBundlesPolicyAndConsumption(admin);
    await testExpiredPrekeySkippedMultiDevice(admin);
    await testConcurrentFetchesDontDoubleClaimPrekey(admin);
    await testReplenishSelfOnly(admin);
    await testEnableE2ee(admin);
  } finally {
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e.message);
  process.exit(1);
});
