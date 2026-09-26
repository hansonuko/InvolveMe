// Real end-to-end encryption, step 6 (docs/21-E2EE-TECHNICAL-DESIGN.md §7)
//
// Verifies the fix for the third CONFIRMED bug this step's adversarial
// review found: session.ts's decryptEnvelope used to unconditionally
// re-bootstrap (initRatchetAsBob) whenever an incoming envelope carried
// X3DH session-establishing fields, with no check for whether a session
// for that sender device already existed. A redelivered copy of the
// original bootstrap envelope — a realistic at-least-once-delivery/
// reconnect scenario, not a contrived attack — would reset an
// already-advanced session back to its pre-conversation state, desyncing
// it from whatever the sender had actually moved on to.
//
// The fix is a one-condition change (only bootstrap `if (!session && ...)`
// — see session.ts's decryptEnvelope). This test can't import session.ts
// itself (RN-only dependencies: expo-secure-store, supabase-js, network
// calls) — it replicates that exact conditional against the real
// x3dh.ts/doubleRatchet.ts to prove the logic holds, the same isolation
// strategy e2ee-concurrency-fix.test.ts already uses for the other two
// fixes in this step.
//
// Run: node supabase/tests/e2ee-bootstrap-replay-fix.test.ts

import { testSodiumProvider as sodium } from '../../apps/mobile/lib/e2ee/sodiumProviderTestAdapter.ts';
import {
  initRatchetAsAlice,
  initRatchetAsBob,
  ratchetDecrypt,
  ratchetEncrypt,
  type RatchetHeader,
  type RatchetState,
} from '../../apps/mobile/lib/e2ee/doubleRatchet.ts';
import { x3dhInitiate, x3dhRespond, type PrekeyBundle } from '../../apps/mobile/lib/e2ee/x3dh.ts';

let passed = 0;
let failed = 0;
function log(label: string, ok: boolean, detail?: string) {
  if (ok) passed++;
  else failed++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`);
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

interface Envelope {
  header: RatchetHeader;
  ciphertext: Uint8Array;
  isBootstrap: boolean;
}

async function main() {
  await sodium.ready();

  const aliceIdentity = sodium.generateX25519KeyPair();
  const bobIdentity = sodium.generateX25519KeyPair();
  const bobSignedPrekey = sodium.generateX25519KeyPair();
  const bobIdentityEd = sodium.generateEd25519KeyPair();
  const signature = sodium.sign(bobSignedPrekey.publicKey, bobIdentityEd.privateKey);

  const bundle: PrekeyBundle = {
    identityKeyEd25519: bobIdentityEd.publicKey,
    identityKeyX25519: bobIdentity.publicKey,
    signedPrekeyPublic: bobSignedPrekey.publicKey,
    signedPrekeySignature: signature,
    oneTimePrekeyPublic: null,
  };

  const initResult = x3dhInitiate(sodium, aliceIdentity.privateKey, bundle);
  const bobRoot = x3dhRespond(sodium, {
    ownIdentityPrivateKeyX25519: bobIdentity.privateKey,
    ownSignedPrekeyPrivateKey: bobSignedPrekey.privateKey,
    ownOneTimePrekeyPrivateKey: null,
    peerIdentityPublicKeyX25519: aliceIdentity.publicKey,
    peerEphemeralPublicKey: initResult.ephemeralPublicKey,
  });

  let alice = initRatchetAsAlice(sodium, initResult.rootKey, bobSignedPrekey.publicKey);
  const ad = utf8('thread:test');

  const envelopes: Envelope[] = [];
  const enc0 = ratchetEncrypt(sodium, alice, utf8('hello bob'), ad);
  alice = enc0.nextState;
  envelopes.push({ header: enc0.header, ciphertext: enc0.ciphertext, isBootstrap: true });

  const enc1 = ratchetEncrypt(sodium, alice, utf8('how are you'), ad);
  alice = enc1.nextState;
  envelopes.push({ header: enc1.header, ciphertext: enc1.ciphertext, isBootstrap: false });

  const enc2 = ratchetEncrypt(sodium, alice, utf8('still there?'), ad);
  alice = enc2.nextState;
  envelopes.push({ header: enc2.header, ciphertext: enc2.ciphertext, isBootstrap: false });

  // Mirrors session.ts's decryptEnvelope exactly: only bootstrap
  // (initRatchetAsBob) when no session already exists for this sender.
  let bobSession: RatchetState | null = null;
  function processEnvelope(envelope: Envelope): string {
    if (!bobSession && envelope.isBootstrap) {
      bobSession = initRatchetAsBob(sodium, bobRoot, bobSignedPrekey);
    }
    if (!bobSession) {
      throw new Error('no session and no bootstrap fields');
    }
    const result = ratchetDecrypt(sodium, bobSession, envelope.header, envelope.ciphertext, ad);
    bobSession = result.nextState;
    return utf8Decode(result.plaintext);
  }

  const decrypted0 = processEnvelope(envelopes[0]);
  log('message 0 (bootstrap) decrypts correctly', decrypted0 === 'hello bob');

  const decrypted1 = processEnvelope(envelopes[1]);
  log(
    'message 1 (regular) decrypts correctly, session already established',
    decrypted1 === 'how are you',
  );

  const sessionBeforeReplay = bobSession as unknown as RatchetState;

  let replayThrew = false;
  try {
    // Redeliver the ORIGINAL bootstrap envelope — simulating a
    // reconnect/at-least-once redelivery of message 0, after the
    // session has already moved on to message 1.
    processEnvelope(envelopes[0]);
  } catch {
    replayThrew = true;
  }
  log(
    'replaying the original bootstrap envelope after the session has advanced fails closed (AEAD auth error), not silently accepted',
    replayThrew,
  );

  const sessionAfterReplay = bobSession as unknown as RatchetState;
  log(
    'the session was NOT reset by the replay attempt — same root key survives',
    Buffer.from(sessionAfterReplay.rootKey).toString('hex') ===
      Buffer.from(sessionBeforeReplay.rootKey).toString('hex'),
  );
  log(
    'the session was NOT reset by the replay attempt — receive position did not regress',
    sessionAfterReplay.recvMessageNumber >= sessionBeforeReplay.recvMessageNumber,
    `before=${sessionBeforeReplay.recvMessageNumber} after=${sessionAfterReplay.recvMessageNumber}`,
  );

  const decrypted2 = processEnvelope(envelopes[2]);
  log(
    'a real subsequent message still decrypts correctly after the replay attempt (session survived intact)',
    decrypted2 === 'still there?',
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
