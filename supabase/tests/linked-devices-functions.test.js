#!/usr/bin/env node
// Linked Devices (WhatsApp-Web-style QR pairing), Milestone 1 —
// docs/12-LINKED-DEVICES-WEB-SCOPING.md. Tests the four SECURITY DEFINER
// RPCs directly (20261009080000_linked_devices_schema.sql), same
// "call as service_role, exactly what the Edge Function will do" pattern
// every other *-functions.test.js file in this directory uses.

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
if (!DB_URL) {
  console.error('SUPABASE_DB_URL is not set. Run via `node --env-file=.env` from the repo root.');
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
  return new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
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

async function createPairing(admin, label = 'Test Browser') {
  const res = await admin.query('select * from public.fn_create_device_pairing($1, $2)', [
    label,
    'web',
  ]);
  return res.rows[0]; // { id, expires_at }
}

async function confirmPairing(admin, pairingId, userId) {
  const res = await admin.query('select public.fn_confirm_device_pairing($1, $2, $3) as id', [
    pairingId,
    userId,
    'android',
  ]);
  return res.rows[0].id;
}

async function main() {
  const admin = newClient();
  await admin.connect();

  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const createdDeviceIds = [];
  const createdPairingIds = [];

  try {
    // --- Happy path ---------------------------------------------------
    const pairing1 = await createPairing(admin, 'Chrome on Windows');
    createdPairingIds.push(pairing1.id);
    log(
      'fn_create_device_pairing returns an id + expires_at',
      !!pairing1.id && !!pairing1.expires_at,
    );

    const deviceId1 = await confirmPairing(admin, pairing1.id, A);
    createdDeviceIds.push(deviceId1);
    log('fn_confirm_device_pairing returns a new linked_device id', !!deviceId1);

    const pairingRow = await admin.query(
      'select confirmed_by_user_id, confirmed_at, linked_device_id from public.device_pairings where id = $1',
      [pairing1.id],
    );
    log(
      'device_pairings row records who confirmed it and which device it linked to',
      pairingRow.rows[0].confirmed_by_user_id === A &&
        pairingRow.rows[0].linked_device_id === deviceId1,
    );

    const listed = await admin.query('select * from public.fn_list_linked_devices($1)', [A]);
    log(
      "fn_list_linked_devices shows the newly-linked device with the pairing's own label",
      listed.rows.length === 1 &&
        listed.rows[0].id === deviceId1 &&
        listed.rows[0].label === 'Chrome on Windows',
    );

    // --- Already-confirmed ---------------------------------------------
    let alreadyConfirmedError = null;
    try {
      await confirmPairing(admin, pairing1.id, A);
    } catch (e) {
      alreadyConfirmedError = e.message;
    }
    log(
      're-confirming an already-confirmed pairing fails, does not create a second device',
      !!alreadyConfirmedError && alreadyConfirmedError.includes('pairing_already_confirmed'),
    );

    // --- Expiry ----------------------------------------------------------
    const pairing2 = await createPairing(admin, 'Expired Test');
    createdPairingIds.push(pairing2.id);
    await admin.query(
      "update public.device_pairings set expires_at = now() - interval '1 second' where id = $1",
      [pairing2.id],
    );
    let expiredError = null;
    try {
      await confirmPairing(admin, pairing2.id, A);
    } catch (e) {
      expiredError = e.message;
    }
    log(
      'confirming an expired pairing hard-fails, not silently paired',
      !!expiredError && expiredError.includes('pairing_expired'),
    );

    // --- Not-found ---------------------------------------------------
    let notFoundError = null;
    try {
      await confirmPairing(admin, crypto.randomUUID(), A);
    } catch (e) {
      notFoundError = e.message;
    }
    log(
      'confirming a nonexistent pairing_id fails cleanly',
      !!notFoundError && notFoundError.includes('pairing_not_found'),
    );

    // --- Concurrency: two devices racing to confirm the SAME pairing ---
    const pairing3 = await createPairing(admin, 'Race Test');
    createdPairingIds.push(pairing3.id);
    const racers = [newClient(), newClient()];
    await Promise.all(racers.map((c) => c.connect()));
    const results = await Promise.allSettled(
      racers.map((c) =>
        c.query('select public.fn_confirm_device_pairing($1, $2, $3) as id', [
          pairing3.id,
          A,
          'web',
        ]),
      ),
    );
    await Promise.all(racers.map((c) => c.end()));
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    log(
      'two concurrent confirms on the same pairing: exactly one succeeds, the other fails — never both',
      succeeded.length === 1 && failed.length === 1,
      `succeeded=${succeeded.length} failed=${failed.length}`,
    );
    if (succeeded.length === 1) createdDeviceIds.push(succeeded[0].value.rows[0].id);

    const raceDeviceCount = await admin.query(
      "select count(*) from public.linked_devices where user_id = $1 and label = 'Race Test'",
      [A],
    );
    log(
      'exactly one linked_devices row exists for the race, not two',
      Number(raceDeviceCount.rows[0].count) === 1,
    );

    // --- Max linked devices cap (5, pricing_config-driven) ---------------
    // A already has 2 real devices from above (deviceId1 + the race
    // winner) — fast-forward by inserting the remaining 3 directly to
    // reach the cap without 3 more full pairing round trips.
    for (let i = 0; i < 3; i++) {
      const r = await admin.query(
        "insert into public.linked_devices (user_id, label, platform) values ($1, $2, 'web') returning id",
        [A, `Filler ${i}`],
      );
      createdDeviceIds.push(r.rows[0].id);
    }
    const countBeforeCap = await admin.query(
      'select count(*) from public.linked_devices where user_id = $1 and revoked_at is null',
      [A],
    );
    log(
      'A now has exactly 5 active linked devices (the cap)',
      Number(countBeforeCap.rows[0].count) === 5,
    );

    const pairing4 = await createPairing(admin, 'Over The Cap');
    createdPairingIds.push(pairing4.id);
    let capError = null;
    try {
      await confirmPairing(admin, pairing4.id, A);
    } catch (e) {
      capError = e.message;
    }
    log(
      'a 6th device is rejected once the 5-device cap is reached',
      !!capError && capError.includes('max_linked_devices_reached'),
    );

    // --- Revoke (single) ---------------------------------------------
    await admin.query('select public.fn_revoke_linked_device($1, $2)', [A, deviceId1]);
    const afterRevoke = await admin.query('select * from public.fn_list_linked_devices($1)', [A]);
    log(
      'revoking one device removes it from fn_list_linked_devices (now 4 of 5)',
      afterRevoke.rows.length === 4 && !afterRevoke.rows.some((r) => r.id === deviceId1),
    );

    // --- Ownership scoping — B can't touch A's devices ------------------
    await admin.query('select public.fn_revoke_linked_device($1, $2)', [B, createdDeviceIds[1]]);
    const unaffected = await admin.query(
      'select revoked_at from public.linked_devices where id = $1',
      [createdDeviceIds[1]],
    );
    log(
      "B calling revoke with A's device id affects nothing — scoped by user_id, not a cross-account bypass",
      unaffected.rows[0].revoked_at === null,
    );

    // --- Revoke all (bulk "log out of all other devices") ---------------
    await admin.query('select public.fn_revoke_linked_device($1, null)', [A]);
    const afterRevokeAll = await admin.query('select * from public.fn_list_linked_devices($1)', [
      A,
    ]);
    log(
      'revoking with a null id revokes every remaining active device for that user',
      afterRevokeAll.rows.length === 0,
    );
  } finally {
    if (createdPairingIds.length) {
      await admin.query('delete from public.device_pairings where id = any($1::uuid[])', [
        createdPairingIds,
      ]);
    }
    await admin.query('delete from public.linked_devices where user_id in ($1,$2)', [A, B]);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
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
