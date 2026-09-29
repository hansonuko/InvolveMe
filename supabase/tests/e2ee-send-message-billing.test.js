#!/usr/bin/env node
// Real end-to-end encryption, step 4 (docs/21-E2EE-TECHNICAL-DESIGN.md §3,
// §4, 20260926170000_e2ee_send_message_billing.sql) — direct DB-level
// tests of fn_send_message's e2ee_status-aware branch, fn_edit_message's
// byte-length treatment, and the (unchanged, but verified) interaction
// with fn_release_escrow's duplicate-content check. Same pattern as
// thread-payer-functions.test.js: plain pg.Client + fn_ calls, not the
// HTTP layer (send-message/edit-message's own request-shape validation —
// envelopes, moderation-skip — is a separate, Edge-Function-layer
// concern from these functions' actual billing/security authority).
//
// Covers: byte-length billing at exact tier boundaries (against
// pricing_config's live values, not hardcoded numbers, so a future
// recalibration doesn't silently break this suite); the message row
// stores body=null/word_count=0 and one e2ee_message_envelopes row per
// recipient device; envelope recipient-device ownership is enforced
// (rejects the sender's own device, rejects a revoked device); media and
// missing/empty envelopes are rejected outright; the byte cap
// (message_max_bytes) is enforced; the free-status-reply feature still
// works without reading any content; ledger conservation across every
// wallet touched; two concurrent e2ee sends on the same thread don't
// double-spend; fn_release_escrow's duplicate-content check provably
// never flags an e2ee message (regression test for the NULL-propagation
// behavior this migration's own header comment describes, verified here
// end-to-end rather than trusted from an isolated query); and
// fn_edit_message's e2ee branch (shrink succeeds and replaces the
// envelope, cost-increase is rejected and leaves the old envelope
// intact).

const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = process.env.SUPABASE_DB_URL;
// Only needed for testE2eeMediaSend's fixture upload (session 37/38 media
// follow-up) — every other test here is a direct pg.Client/fn_ call, same
// as this file's own header comment describes.
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const [name, val] of Object.entries({
  SUPABASE_DB_URL: DB_URL,
  EXPO_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
})) {
  if (!val) {
    console.error(
      `${name} is not set. Run via \`npm run test:e2ee-send-message-billing\` from the repo root.`,
    );
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
  await admin.query('alter table public.ledger_entries disable trigger ledger_entries_no_delete');
  await admin.query(
    `delete from public.ledger_entries where wallet_id in (select id from public.wallets where user_id = $1)`,
    [id],
  );
  await admin.query('alter table public.ledger_entries enable trigger ledger_entries_no_delete');
  await admin.query('delete from auth.users where id = $1', [id]); // cascades to public.users, e2ee_devices
}

async function deleteTestThread(admin, threadId) {
  await admin.query(
    `delete from public.e2ee_message_envelopes where message_id in (select id from public.messages where thread_id = $1)`,
    [threadId],
  );
  await admin.query("delete from public.fraud_signals where metadata->>'thread_id' = $1", [
    threadId,
  ]);
  await admin.query('delete from public.escrows where thread_id = $1', [threadId]);
  await admin.query('delete from public.messages where thread_id = $1', [threadId]);
  await admin.query('delete from public.threads where id = $1', [threadId]);
}

async function walletRow(admin, userId, kind) {
  const r = await admin.query(
    'select id, balance, is_frozen from public.wallets where user_id=$1 and kind=$2',
    [userId, kind],
  );
  return r.rows[0];
}

async function ledgerSum(admin, walletId) {
  const r = await admin.query(
    'select coalesce(sum(amount), 0) as sum from public.ledger_entries where wallet_id = $1',
    [walletId],
  );
  return Number(r.rows[0].sum);
}

async function fundTopupCredit(admin, userId, credits) {
  const wallet = await walletRow(admin, userId, 'topup_credit');
  await admin.query(
    `insert into public.ledger_entries (wallet_id, amount, reason) values ($1, $2, 'manual_adjustment')`,
    [wallet.id, credits],
  );
}

async function pricingConfig(admin, key, currency = 'NGN') {
  const r = await admin.query(
    'select value from public.pricing_config where key = $1 and currency = $2',
    [key, currency],
  );
  if (!r.rows[0]) throw new Error(`pricing_config not found: ${key} ${currency}`);
  return Number(r.rows[0].value);
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

async function registerDevice(admin, userId) {
  const res = await admin.query(
    `select public.fn_register_e2ee_device($1, $2, $3, $4, $5, $6, $7, $8, $9) as device_id`,
    [
      userId,
      'test device',
      randomBase64(32),
      randomBase64(32),
      1,
      randomBase64(32),
      randomBase64(64),
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      JSON.stringify(fakePrekeyBatch(3)),
    ],
  );
  return res.rows[0].device_id;
}

// `ciphertextByteLength` is the TOTAL wire ciphertext length (including
// the 16-byte Poly1305 tag fn_send_message subtracts before billing) —
// callers pick this to land on a specific byte_count precisely.
function makeEnvelope(recipientDeviceId, ciphertextByteLength) {
  return {
    recipient_device_id: recipientDeviceId,
    ciphertext: randomBase64(ciphertextByteLength),
    ratchet_public_key: randomBase64(32),
    previous_chain_length: 0,
    message_number: 0,
    x3dh_sender_identity_key: null,
    x3dh_sender_ephemeral_key: null,
    x3dh_one_time_prekey_id: null,
  };
}

/** Uploads a real fixture object via the Storage REST API (service-role
 * key) so `fn_send_message`'s media_not_found existence check has a real
 * `storage.objects` row to find — same pattern as chat-media-storage-
 * rls.test.js's own `uploadFixtureImage`, generalized to accept arbitrary
 * bytes/content-type since an e2ee attachment's real upload is opaque
 * ciphertext (`application/octet-stream`, migration 20260929100000), not a
 * real JPEG. */
async function uploadFixtureObject(userId, bytes, contentType) {
  const objectPath = `${userId}/${crypto.randomUUID()}.bin`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/chat-media/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`uploadFixtureObject failed: ${res.status} ${await res.text()}`);
  return objectPath;
}

async function deleteFixtureObject(objectPath) {
  await fetch(`${SUPABASE_URL}/storage/v1/object/chat-media/${objectPath}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
}

async function setupE2eeThread(admin) {
  const A = await createTestUser(admin);
  const B = await createTestUser(admin);
  const threadRes = await admin.query('select public.fn_start_thread($1, $2) as id', [A, B]);
  const threadId = threadRes.rows[0].id;
  await fundTopupCredit(admin, A, 1000);

  const deviceA = await registerDevice(admin, A);
  const deviceB = await registerDevice(admin, B);
  await admin.query('select public.fn_enable_e2ee($1, $2)', [threadId, A]);

  return { A, B, deviceA, deviceB, threadId };
}

async function sendE2ee(admin, threadId, senderId, envelopes, extra = {}) {
  const r = await admin.query(
    `select * from public.fn_send_message(
       p_thread_id => $1, p_sender_id => $2, p_body => $3,
       p_envelopes => $4::jsonb, p_reply_to_status_id => $5
     )`,
    [threadId, senderId, '', JSON.stringify(envelopes ?? null), extra.replyToStatusId ?? null],
  );
  return r.rows[0];
}

/** Same as sendE2ee, but carries a media attachment — session 37/38's
 * e2ee-media follow-up. Separate helper rather than extending sendE2ee's
 * own signature: every existing caller of sendE2ee is a text-only send and
 * shouldn't have to thread `undefined`s through for fields that don't
 * apply to it. */
async function sendE2eeWithMedia(admin, threadId, senderId, envelopes, mediaPath, mediaType) {
  const r = await admin.query(
    `select * from public.fn_send_message(
       p_thread_id => $1, p_sender_id => $2, p_body => '',
       p_envelopes => $3::jsonb, p_media_path => $4, p_media_type => $5
     )`,
    [threadId, senderId, JSON.stringify(envelopes ?? null), mediaPath, mediaType],
  );
  return r.rows[0];
}

async function editE2ee(admin, messageId, senderId, envelopes) {
  const r = await admin.query(
    `select * from public.fn_edit_message(
       p_message_id => $1, p_sender_id => $2, p_envelopes => $3::jsonb
     )`,
    [messageId, senderId, JSON.stringify(envelopes)],
  );
  return r.rows[0];
}

async function envelopesForMessage(admin, messageId) {
  const r = await admin.query(
    'select recipient_device_id, ciphertext, ratchet_public_key, previous_chain_length, message_number from public.e2ee_message_envelopes where message_id = $1 order by recipient_device_id',
    [messageId],
  );
  return r.rows;
}

async function messageRow(admin, messageId) {
  const r = await admin.query(
    'select body, word_count, credits_charged, status from public.messages where id = $1',
    [messageId],
  );
  return r.rows[0];
}

async function expectException(promise, expectedPrefix, label) {
  try {
    await promise;
    log(label, false, 'expected an exception, got none');
  } catch (e) {
    log(label, e.message.startsWith(expectedPrefix), e.message);
  }
}

// ===========================================================================
// Test 1: byte-length billing at exact tier boundaries, read from live
// pricing_config rather than hardcoded numbers.
// ===========================================================================

async function testByteBillingBoundaries(admin) {
  const { A, B, deviceB, threadId } = await setupE2eeThread(admin);
  try {
    const blockSize = await pricingConfig(admin, 'message_byte_block_size');
    const baseCredits = await pricingConfig(admin, 'message_byte_base_credits');

    const cases = [
      { totalLen: 17, expectedBlocks: 1 }, // 1 plaintext byte, smallest possible
      { totalLen: 16 + blockSize, expectedBlocks: 1 }, // exactly at the boundary
      { totalLen: 16 + blockSize + 1, expectedBlocks: 2 }, // one byte over
    ];

    for (const c of cases) {
      const result = await sendE2ee(admin, threadId, A, [makeEnvelope(deviceB, c.totalLen)]);
      const expectedCredits = baseCredits * c.expectedBlocks;
      log(
        `ciphertext length ${c.totalLen} bytes charges ${expectedCredits} credits (${c.expectedBlocks} block(s))`,
        Number(result.credits_charged) === expectedCredits,
        `got ${result.credits_charged}`,
      );
    }
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 2: the message row and envelope row(s) are stored correctly.
// ===========================================================================

async function testMessageAndEnvelopeStorage(admin) {
  const { A, B, deviceB, threadId } = await setupE2eeThread(admin);
  try {
    const envelope = makeEnvelope(deviceB, 64);
    const result = await sendE2ee(admin, threadId, A, [envelope]);

    const msg = await messageRow(admin, result.message_id);
    log('body is stored as null (no plaintext server-side)', msg.body === null);
    log('word_count is 0 (not applicable to an encrypted message)', msg.word_count === 0);
    log('status is escrowed', msg.status === 'escrowed');

    const envelopes = await envelopesForMessage(admin, result.message_id);
    log('exactly one envelope row was created', envelopes.length === 1);
    log(
      'ciphertext round-trips exactly',
      envelopes[0].ciphertext.toString('base64') === envelope.ciphertext,
    );
    log(
      'ratchet_public_key round-trips exactly',
      envelopes[0].ratchet_public_key.toString('base64') === envelope.ratchet_public_key,
    );
    log("recipient_device_id is B's device", envelopes[0].recipient_device_id === deviceB);
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 3: multiple envelopes (multi-device recipient) all get inserted;
// billing reads the FIRST array element's ciphertext length, per §4.
// ===========================================================================

async function testMultipleEnvelopesBillFromFirst(admin) {
  const { A, B, deviceB, threadId } = await setupE2eeThread(admin);
  const deviceB2 = await registerDevice(admin, B);
  try {
    const blockSize = await pricingConfig(admin, 'message_byte_block_size');
    const baseCredits = await pricingConfig(admin, 'message_byte_base_credits');

    // First envelope: 1 block. Second envelope: deliberately a different
    // (larger, 2-block) length, to prove billing reads only envelopes[0]
    // — in real client use every envelope for one message carries
    // identical plaintext and is therefore the same length, but this
    // isolates exactly which array element the server actually reads.
    const envelopes = [makeEnvelope(deviceB, 17), makeEnvelope(deviceB2, 16 + blockSize + 1)];
    const result = await sendE2ee(admin, threadId, A, envelopes);

    log(
      'billing is based on envelopes[0], not the largest envelope',
      Number(result.credits_charged) === baseCredits * 1,
      `got ${result.credits_charged}`,
    );

    const stored = await envelopesForMessage(admin, result.message_id);
    log('both envelopes were inserted, one per recipient device', stored.length === 2);
    log(
      "both of B's devices are represented",
      stored.some((e) => e.recipient_device_id === deviceB) &&
        stored.some((e) => e.recipient_device_id === deviceB2),
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 4: envelope recipient-device ownership is enforced.
// ===========================================================================

async function testEnvelopeRecipientOwnership(admin) {
  const { A, B, deviceA, deviceB, threadId } = await setupE2eeThread(admin);
  try {
    await expectException(
      sendE2ee(admin, threadId, A, [makeEnvelope(deviceA, 64)]),
      'invalid_envelope_recipient_device',
      "sending an envelope addressed to the SENDER's own device is rejected",
    );

    await admin.query('update public.e2ee_devices set revoked_at = now() where id = $1', [deviceB]);
    await expectException(
      sendE2ee(admin, threadId, A, [makeEnvelope(deviceB, 64)]),
      'invalid_envelope_recipient_device',
      'sending an envelope addressed to a REVOKED device is rejected',
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 5: media at a nonexistent path is still rejected (real media, tested
// separately below, IS now supported on e2ee threads — session 37/38 —
// this just proves the shared media_not_found existence check, moved out
// of the non-e2ee-only branch by that same migration, actually runs for
// e2ee sends too); missing/empty envelopes are rejected; the byte cap is
// enforced.
// ===========================================================================

async function testGuardrails(admin) {
  const { A, deviceB, threadId } = await setupE2eeThread(admin);
  try {
    const mediaResult = admin.query(
      `select * from public.fn_send_message(
         p_thread_id => $1, p_sender_id => $2, p_body => '', p_media_path => $3, p_media_type => 'image',
         p_envelopes => $4::jsonb
       )`,
      [threadId, A, `${A}/fake.jpg`, JSON.stringify([makeEnvelope(deviceB, 64)])],
    );
    await expectException(
      mediaResult,
      'media_not_found',
      'media at a path with no real storage.objects row is rejected',
    );

    await expectException(
      sendE2ee(admin, threadId, A, null),
      'e2ee_envelopes_required',
      'null envelopes on an e2ee-active thread is rejected',
    );
    await expectException(
      sendE2ee(admin, threadId, A, []),
      'e2ee_envelopes_required',
      'an empty envelopes array is rejected',
    );

    const maxBytes = await pricingConfig(admin, 'message_max_bytes');
    await expectException(
      sendE2ee(admin, threadId, A, [makeEnvelope(deviceB, 16 + maxBytes + 1)]),
      'message_too_long',
      'a ciphertext exceeding message_max_bytes is rejected',
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
  }
}

// ===========================================================================
// Test 5b: a real media send on an e2ee-active thread — session 37/38's
// actual media-support feature (migration 20260929100000). Verifies the
// message is created with real media_path/media_type stored, billing is
// byte-based caption cost PLUS the same flat message_media_credits
// surcharge non-e2ee media already charges (never based on the envelope's
// own ciphertext length — that would only measure the tiny
// {text, mediaKey, mediaNonce} JSON metadata, not the actual attachment,
// exactly the loophole this migration's own header comment warns about),
// and that ledger conservation holds across every wallet touched.
// ===========================================================================

async function testE2eeMediaSendBilling(admin) {
  const { A, B, deviceA, deviceB, threadId } = await setupE2eeThread(admin);
  let objectPath = null;
  try {
    objectPath = await uploadFixtureObject(
      A,
      Buffer.from('fake-ciphertext-bytes'),
      'application/octet-stream',
    );

    const blockSize = await pricingConfig(admin, 'message_byte_block_size');
    const baseCredits = await pricingConfig(admin, 'message_byte_base_credits');
    const mediaCredits = await pricingConfig(admin, 'message_media_credits');

    // 1 block worth of caption ciphertext (the {text, mediaKey, mediaNonce}
    // JSON blob, in real client use) plus the attachment itself, already
    // uploaded above.
    const envelope = makeEnvelope(deviceB, 16 + blockSize);
    const result = await sendE2eeWithMedia(admin, threadId, A, [envelope], objectPath, 'image');

    log(
      'billing is byte-based caption cost plus the flat media surcharge, not envelope-length-based media billing',
      Number(result.credits_charged) === baseCredits * 1 + mediaCredits,
      `got ${result.credits_charged}, expected ${baseCredits + mediaCredits}`,
    );
    log(
      'status is escrowed (media never rides the free-status-reply path)',
      result.status === 'escrowed',
    );

    const msg = await admin.query(
      'select media_path, media_type, body from public.messages where id = $1',
      [result.message_id],
    );
    log('media_path is stored', msg.rows[0].media_path === objectPath);
    log("media_type is stored as 'image'", msg.rows[0].media_type === 'image');
    log(
      'body stays null (no server-side plaintext) even for a media message',
      msg.rows[0].body === null,
    );

    const envelopes = await envelopesForMessage(admin, result.message_id);
    log(
      'the envelope (carrying the caption + attachment key/nonce, client-side) was still stored',
      envelopes.length === 1,
    );

    // B replies so A's escrow actually releases, touching every wallet a
    // real send affects — same shape as testLedgerConservation below.
    await sendE2ee(admin, threadId, B, [makeEnvelope(deviceA, 64)]);

    let allReconciled = true;
    const details = [];
    for (const [userId, kind] of [
      [A, 'topup_credit'],
      [B, 'earnings_pending'],
      [B, 'withdrawable_cash'],
    ]) {
      const w = await walletRow(admin, userId, kind);
      const sum = await ledgerSum(admin, w.id);
      const ok = sum === Number(w.balance);
      if (!ok) allReconciled = false;
      details.push({ userId, kind, balance: w.balance, sum, ok });
    }
    log(
      'ledger conservation holds across every wallet touched by an e2ee media send',
      allReconciled,
      JSON.stringify(details.filter((d) => !d.ok)),
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
    if (objectPath) await deleteFixtureObject(objectPath);
  }
}

// ===========================================================================
// Test 6: the free-status-reply feature (docs/18 §B1) still works on an
// e2ee-active thread — purely structural, reads no content.
// ===========================================================================

async function testFreeStatusReplyStillWorks(admin) {
  const { A, B, deviceB, threadId } = await setupE2eeThread(admin);
  let statusIdToClean = null;
  try {
    const statusRes = await admin.query(
      `insert into public.status_updates (user_id, caption, credits_charged, expires_at)
       values ($1, 'a status', 0, now() + interval '1 day') returning id`,
      [B],
    );
    const statusId = statusRes.rows[0].id;

    const result = await sendE2ee(admin, threadId, A, [makeEnvelope(deviceB, 64)], {
      replyToStatusId: statusId,
    });

    log(
      'a first-message status reply on an e2ee thread is free',
      Number(result.credits_charged) === 0,
    );
    log('its status is sent, not escrowed', result.status === 'sent');

    const envelopes = await envelopesForMessage(admin, result.message_id);
    log('the envelope is still stored even though the message is free', envelopes.length === 1);

    statusIdToClean = statusId;
  } finally {
    await deleteTestThread(admin, threadId);
    // messages.reply_to_status_id has no ON DELETE CASCADE — this must
    // run after deleteTestThread has removed the referencing message, or
    // it fails with a foreign-key violation.
    if (statusIdToClean) {
      await admin.query('delete from public.status_updates where id = $1', [statusIdToClean]);
    }
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 7: ledger conservation across every wallet touched by an e2ee send
// (CLAUDE.md's standing requirement for any balance-mutating function).
// ===========================================================================

async function testLedgerConservation(admin) {
  const { A, B, deviceA, deviceB, threadId } = await setupE2eeThread(admin);
  try {
    const result = await sendE2ee(admin, threadId, A, [makeEnvelope(deviceB, 64)]);
    log('message escrowed with a positive charge', Number(result.credits_charged) > 0);

    // fn_send_message calls fn_release_escrow unconditionally on every
    // send, but only for escrows where the SENDER is the payee — A's own
    // escrow (payee=B) only releases once B sends something. Have B
    // reply so that release actually happens and touches B's earnings
    // wallets too.
    await sendE2ee(admin, threadId, B, [makeEnvelope(deviceA, 64)]);

    let allReconciled = true;
    const details = [];
    for (const [userId, kind] of [
      [A, 'topup_credit'],
      [B, 'earnings_pending'],
      [B, 'withdrawable_cash'],
    ]) {
      const w = await walletRow(admin, userId, kind);
      const sum = await ledgerSum(admin, w.id);
      const ok = sum === Number(w.balance);
      if (!ok) allReconciled = false;
      details.push({ userId, kind, balance: w.balance, sum, ok });
    }
    for (const kind of ['platform_revenue_earnings_cut', 'platform_reserve_earnings_cut']) {
      const w = (
        await admin.query(
          'select id, balance from public.wallets where kind=$1 and user_id is null',
          [kind],
        )
      ).rows[0];
      const sum = await ledgerSum(admin, w.id);
      const ok = sum === Number(w.balance);
      if (!ok) allReconciled = false;
      details.push({ kind, balance: w.balance, sum, ok });
    }
    log(
      'ledger conservation holds on every wallet touched by an e2ee send',
      allReconciled,
      JSON.stringify(details.filter((d) => !d.ok)),
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 8: fn_release_escrow's duplicate-content check never flags an
// e2ee-active message — regression test for the NULL-propagation
// behavior this migration's own comment describes, verified end-to-end.
// ===========================================================================

async function testDuplicateContentNeverFlagsE2ee(admin) {
  const { A, B, deviceB, deviceA, threadId } = await setupE2eeThread(admin);
  try {
    // B replies first so A's subsequent messages have something to
    // release against; then A sends two messages back-to-back — on a
    // plaintext thread, two identical bodies from the same sender would
    // trip the duplicate-content fraud signal on the second release.
    await sendE2ee(admin, threadId, B, [makeEnvelope(deviceA, 64)]);

    const identicalEnvelope = () => ({ ...makeEnvelope(deviceB, 64) });
    const first = await sendE2ee(admin, threadId, A, [identicalEnvelope()]);
    const second = await sendE2ee(admin, threadId, A, [identicalEnvelope()]);

    // A is the fixed payer here, so fn_release_escrow(thread, A) (called
    // automatically at the end of each of A's own sends above) finds
    // nothing to release — every escrow's payee_id is B, never A. One
    // more send from B releases every pending escrow whose payee is B in
    // a single call, including both of A's messages above — that's the
    // real release path this test needs to exercise.
    await sendE2ee(admin, threadId, B, [makeEnvelope(deviceA, 64)]);

    const firstStatus = await messageRow(admin, first.message_id);
    const secondStatus = await messageRow(admin, second.message_id);
    log(
      'both e2ee messages end up released, neither held as a suspected duplicate',
      firstStatus.status === 'released' && secondStatus.status === 'released',
      `first=${firstStatus.status} second=${secondStatus.status}`,
    );

    const fraudSignals = await admin.query(
      `select id from public.fraud_signals where user_id = $1 and signal_type = 'duplicate_content'`,
      [A],
    );
    log('no duplicate_content fraud signal was raised for A', fraudSignals.rows.length === 0);
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

// ===========================================================================
// Test 9: concurrency — two simultaneous e2ee sends on the same thread
// don't double-spend or corrupt the payer's wallet. fn_send_message's
// `for update` lock on the thread row serializes them.
// ===========================================================================

async function testConcurrentSendsDoNotDoubleSpend(admin) {
  const { A, deviceB, threadId } = await setupE2eeThread(admin);
  try {
    const before = await walletRow(admin, A, 'topup_credit');

    const client1 = newClient();
    const client2 = newClient();
    await client1.connect();
    await client2.connect();

    const query = (client) =>
      client.query(
        `select * from public.fn_send_message(
           p_thread_id => $1, p_sender_id => $2, p_body => '', p_envelopes => $3::jsonb
         )`,
        [threadId, A, JSON.stringify([makeEnvelope(deviceB, 64)])],
      );

    const results = await Promise.allSettled([query(client1), query(client2)]);
    await client1.end();
    await client2.end();

    const bothSucceeded = results.every((r) => r.status === 'fulfilled');
    log('both concurrent e2ee sends complete without error (no deadlock)', bothSucceeded);

    const messageCount = await admin.query(
      'select count(*) as n from public.messages where thread_id = $1',
      [threadId],
    );
    log('exactly 2 messages were created', Number(messageCount.rows[0].n) === 2);

    const after = await walletRow(admin, A, 'topup_credit');
    const eachCharge =
      results[0].status === 'fulfilled' ? Number(results[0].value.rows[0].credits_charged) : null;
    const expectedAfter = eachCharge !== null ? Number(before.balance) - eachCharge * 2 : null;
    log(
      "the payer's wallet was debited exactly twice, not corrupted by the race",
      expectedAfter !== null && Number(after.balance) === expectedAfter,
      `before=${before.balance} after=${after.balance} eachCharge=${eachCharge}`,
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
  }
}

// ===========================================================================
// Test 10: fn_edit_message's e2ee branch — shrinking succeeds and
// replaces the envelope; a cost increase is rejected and leaves the
// original envelope untouched.
// ===========================================================================

async function testEditMessageE2ee(admin) {
  const { A, B, deviceB, threadId } = await setupE2eeThread(admin);
  try {
    const blockSize = await pricingConfig(admin, 'message_byte_block_size');
    const original = await sendE2ee(admin, threadId, A, [
      makeEnvelope(deviceB, 16 + blockSize + 1),
    ]); // 2 blocks

    const smallerEnvelope = makeEnvelope(deviceB, 17); // 1 block — fits within the 2-block charge
    const editResult = await editE2ee(admin, original.message_id, A, [smallerEnvelope]);
    log(
      'shrinking the message on edit succeeds',
      Number(editResult.credits_charged) === Number(original.credits_charged),
      'credits_charged must stay exactly what was originally paid',
    );

    const afterShrink = await envelopesForMessage(admin, original.message_id);
    log(
      'the old envelope was replaced with the new (smaller) one',
      afterShrink.length === 1 &&
        afterShrink[0].ciphertext.toString('base64') === smallerEnvelope.ciphertext,
    );

    const biggerEnvelope = makeEnvelope(deviceB, 16 + blockSize * 10 + 1); // far more blocks than already charged
    await expectException(
      editE2ee(admin, original.message_id, A, [biggerEnvelope]),
      'edit_would_increase_cost',
      'growing the message past the already-charged tier is rejected',
    );

    const afterRejectedEdit = await envelopesForMessage(admin, original.message_id);
    log(
      'the envelope is unchanged after a rejected edit (no partial write)',
      afterRejectedEdit.length === 1 &&
        afterRejectedEdit[0].ciphertext.toString('base64') === smallerEnvelope.ciphertext,
    );
  } finally {
    await deleteTestThread(admin, threadId);
    await deleteTestUser(admin, A);
    await deleteTestUser(admin, B);
  }
}

async function main() {
  const admin = newClient();
  await admin.connect();

  try {
    await testByteBillingBoundaries(admin);
    await testMessageAndEnvelopeStorage(admin);
    await testMultipleEnvelopesBillFromFirst(admin);
    await testEnvelopeRecipientOwnership(admin);
    await testGuardrails(admin);
    await testE2eeMediaSendBilling(admin);
    await testFreeStatusReplyStillWorks(admin);
    await testLedgerConservation(admin);
    await testDuplicateContentNeverFlagsE2ee(admin);
    await testConcurrentSendsDoNotDoubleSpend(admin);
    await testEditMessageE2ee(admin);
  } finally {
    await admin.end();
  }

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(1);
});
