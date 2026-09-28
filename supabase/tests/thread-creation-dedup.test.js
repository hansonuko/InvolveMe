#!/usr/bin/env node
// Real, live, user-reported bug (session 37): a second, disconnected
// thread appeared between two people who already had one — `fn_start_
// thread`'s existing-thread lookup only ever checked one ordering of
// (participant_a, participant_b), so the other participant's own "start a
// thread with you" call missed the existing thread and created a new one.
// Fixed in 20260927150000_fix_duplicate_thread_creation.sql: the lookup
// now checks both orderings, and a schema-level unique index on the
// unordered pair closes the gap permanently regardless of future
// application-code correctness.

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

async function main() {
  const admin = newClient();
  await admin.connect();

  const A = await createTestUser(admin);
  const B = await createTestUser(admin);

  try {
    const t1 = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B])).rows[0]
      .id;
    log('A starting a thread with B creates one thread', !!t1);

    const t2 = (await admin.query('select public.fn_start_thread($1, $2) as id', [B, A])).rows[0]
      .id;
    log(
      'B starting a thread with A (reverse order) returns the SAME thread, not a new one — the actual bug, reproduced and fixed',
      t2 === t1,
      `t1=${t1} t2=${t2}`,
    );

    const t3 = (await admin.query('select public.fn_start_thread($1, $2) as id', [A, B])).rows[0]
      .id;
    log('calling it again in the original order still returns the same thread', t3 === t1);

    const count = await admin.query(
      'select count(*) from public.threads where (participant_a = $1 and participant_b = $2) or (participant_a = $2 and participant_b = $1)',
      [A, B],
    );
    log(
      'exactly one thread row exists for this pair despite three calls in both directions',
      Number(count.rows[0].count) === 1,
    );

    const payer = await admin.query('select payer_id from public.threads where id = $1', [t1]);
    log(
      "the thread's payer_id is still the true initiator (A), unaffected by B's later reverse-order call",
      payer.rows[0].payer_id === A,
    );

    // Defense-in-depth: the schema-level unique index must reject a raw
    // duplicate insert directly, independent of fn_start_thread ever being
    // called correctly.
    let indexRejected = false;
    try {
      await admin.query(
        `insert into public.threads (participant_a, participant_b, payer_id) values ($1, $2, $1)`,
        [B, A],
      );
    } catch (e) {
      indexRejected = e.message.includes('threads_participant_pair_unique');
    }
    log(
      'the schema-level unique index rejects a raw duplicate insert in the reverse order too',
      indexRejected,
    );
  } finally {
    await admin.query(
      'delete from public.threads where participant_a in ($1,$2) or participant_b in ($1,$2)',
      [A, B],
    );
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
