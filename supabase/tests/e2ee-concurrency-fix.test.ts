// Real end-to-end encryption, step 6 (docs/21-E2EE-TECHNICAL-DESIGN.md §7)
//
// Verifies the fix for the two CONFIRMED bugs this step's adversarial
// review found: concurrent encrypts for the same device landing on the
// same ratchet chain position (real AEAD key+nonce reuse across two
// different plaintexts), and concurrent decrypts letting a losing call's
// stale-based save overwrite a winning call's, resurrecting an
// already-consumed message key. Both traced to one root cause —
// session.ts's load-ratchet-save sequence had nothing serializing two
// overlapping calls for the same device — fixed with deviceLock.ts (a
// real per-key async mutex, exercised here directly, not mocked).
//
// This tests the actual `withDeviceLock` module (apps/mobile/lib/e2ee/
// deviceLock.ts) and the actual `doubleRatchet.ts` ratchet logic against
// an in-memory stand-in for sessionStore.ts's get/set storage contract
// (which does no cryptography of its own — a real SecureStore-backed
// version differs only in where the bytes live, not in the race this
// test is about). session.ts itself can't run under plain Node (it
// imports expo-secure-store/@react-native-async-storage/supabase-js,
// all RN/network-only) — this isolates the actual fix mechanism instead
// of trying to mock an entire RN environment just to exercise it.
//
// Run: node supabase/tests/e2ee-concurrency-fix.test.ts

import { testSodiumProvider as sodium } from '../../apps/mobile/lib/e2ee/sodiumProviderTestAdapter.ts';
import {
  initRatchetAsAlice,
  initRatchetAsBob,
  ratchetDecrypt,
  ratchetEncrypt,
  type RatchetState,
} from '../../apps/mobile/lib/e2ee/doubleRatchet.ts';
import { withDeviceLock } from '../../apps/mobile/lib/e2ee/deviceLock.ts';
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
function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function bootstrapPair(): { alice: RatchetState; bob: RatchetState } {
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

  const alice = initRatchetAsAlice(sodium, initResult.rootKey, bobSignedPrekey.publicKey);
  const bob = initRatchetAsBob(sodium, bobRoot, bobSignedPrekey);
  return { alice, bob };
}

// ===========================================================================
// Bug 1: concurrent encrypts for the same device — without a lock, both
// read the same base state and both land on the same chain position,
// producing two ciphertexts under the identical (key, nonce).
// ===========================================================================

async function testConcurrentEncryptsWithoutLock() {
  const { alice } = bootstrapPair();
  const store = new Map<string, RatchetState>([['device-a', alice]]);
  const ad = utf8('thread:test');

  async function unlockedEncrypt(plaintext: string) {
    const state = store.get('device-a')!; // read
    await Promise.resolve(); // force a real async interleaving point, like an actual await would
    const result = ratchetEncrypt(sodium, state, utf8(plaintext), ad); // compute
    store.set('device-a', result.nextState); // write — last writer wins
    return result;
  }

  const [resultA, resultB] = await Promise.all([
    unlockedEncrypt('my bank pin is 4471'),
    unlockedEncrypt('meet at the usual place'),
  ]);

  const sameChainPosition = resultA.header.messageNumber === resultB.header.messageNumber;
  const sameRatchetKey =
    hex(resultA.header.ratchetPublicKey) === hex(resultB.header.ratchetPublicKey);
  log(
    'reproduces the bug: two concurrent unlocked encrypts collide on the same chain position (same key+nonce)',
    sameChainPosition && sameRatchetKey,
    `msgNumA=${resultA.header.messageNumber} msgNumB=${resultB.header.messageNumber}`,
  );
}

async function testConcurrentEncryptsWithLock() {
  const { alice, bob } = bootstrapPair();
  const store = new Map<string, RatchetState>([['device-a', alice]]);
  const ad = utf8('thread:test');

  async function lockedEncrypt(plaintext: string) {
    return withDeviceLock('thread-x:device-a', async () => {
      const state = store.get('device-a')!;
      await Promise.resolve();
      const result = ratchetEncrypt(sodium, state, utf8(plaintext), ad);
      store.set('device-a', result.nextState);
      return result;
    });
  }

  const [resultA, resultB] = await Promise.all([
    lockedEncrypt('my bank pin is 4471'),
    lockedEncrypt('meet at the usual place'),
  ]);

  const messageNumbers = [resultA.header.messageNumber, resultB.header.messageNumber].sort();
  log(
    'fixed: two concurrent locked encrypts land on distinct chain positions',
    messageNumbers[0] === 0 && messageNumbers[1] === 1,
    `got ${JSON.stringify(messageNumbers)}`,
  );

  const finalState = store.get('device-a')!;
  log('the store reflects BOTH increments, not just one', finalState.sendMessageNumber === 2);

  // Bob should be able to decrypt both, in order, with no key/nonce collision.
  let bobState = bob;
  const first = resultA.header.messageNumber < resultB.header.messageNumber ? resultA : resultB;
  const second = resultA.header.messageNumber < resultB.header.messageNumber ? resultB : resultA;
  const dec1 = ratchetDecrypt(sodium, bobState, first.header, first.ciphertext, ad);
  bobState = dec1.nextState;
  const dec2 = ratchetDecrypt(sodium, bobState, second.header, second.ciphertext, ad);
  log(
    'both messages independently decrypt to their own distinct plaintext (no XOR-recoverable collision)',
    (utf8Decode(dec1.plaintext) === 'my bank pin is 4471' &&
      utf8Decode(dec2.plaintext) === 'meet at the usual place') ||
      (utf8Decode(dec1.plaintext) === 'meet at the usual place' &&
        utf8Decode(dec2.plaintext) === 'my bank pin is 4471'),
  );
}

// ===========================================================================
// Bug 2: concurrent decrypts for the same sender device — without a lock,
// the loser's stale-based save can overwrite the winner's, resurrecting
// an already-consumed message key in the persisted state.
// ===========================================================================

async function testConcurrentDecryptsWithoutLock() {
  const { alice, bob } = bootstrapPair();
  const ad = utf8('thread:test');

  const enc0 = ratchetEncrypt(sodium, alice, utf8('first'), ad);
  const enc1 = ratchetEncrypt(sodium, enc0.nextState, utf8('second'), ad);

  const store = new Map<string, RatchetState>([['device-a', bob]]);

  async function unlockedDecrypt(header: typeof enc0.header, ciphertext: Uint8Array) {
    const state = store.get('device-a')!;
    await Promise.resolve();
    const result = ratchetDecrypt(sodium, state, header, ciphertext, ad);
    store.set('device-a', result.nextState);
    return result;
  }

  // Deliver message 1 first (forces message 0's key into the skip cache
  // as a side effect of decrypting message 1), racing against message 0
  // arriving concurrently. Both read the store before either writes —
  // message 1's decrypt actually succeeds first and correctly advances
  // recvMessageNumber to 2 with message 0's key cached as skipped, but
  // message 0's concurrent call started from the SAME stale pre-race
  // snapshot (recvMessageNumber 0, no dhRemotePublicKey yet) and, because
  // that stale snapshot looks like a fresh session, independently
  // re-derives message 0's key via its own from-scratch DH ratchet step
  // and finishes LAST — silently discarding message 1's already-completed
  // decrypt from the store. Concretely: the real message key gets
  // computed and used correctly by each call in isolation (nothing here
  // depends on getting the exact same corruption shape as any other run),
  // but the final persisted state regresses to "only message 0 was ever
  // processed" even though message 1 really was successfully decrypted a
  // moment earlier and then lost — a genuine lost-update race, the same
  // missing-lock defect the resurrected-key symptom (docs/21 §7's
  // original finding) is a different concrete manifestation of.
  const [decrypt1, decrypt0] = await Promise.all([
    unlockedDecrypt(enc1.header, enc1.ciphertext),
    unlockedDecrypt(enc0.header, enc0.ciphertext),
  ]);

  const finalState = store.get('device-a')!;
  log(
    'both concurrent calls individually decrypt correctly in isolation',
    utf8Decode(decrypt1.plaintext) === 'second' && utf8Decode(decrypt0.plaintext) === 'first',
  );
  log(
    "reproduces the bug: the final persisted state lost message 1's already-completed advance (recvMessageNumber regressed to 1, not 2)",
    finalState.recvMessageNumber < 2,
    `recvMessageNumber=${finalState.recvMessageNumber}`,
  );
}

async function testConcurrentDecryptsWithLock() {
  const { alice, bob } = bootstrapPair();
  const ad = utf8('thread:test');

  const enc0 = ratchetEncrypt(sodium, alice, utf8('first'), ad);
  const enc1 = ratchetEncrypt(sodium, enc0.nextState, utf8('second'), ad);

  const store = new Map<string, RatchetState>([['device-a', bob]]);

  async function lockedDecrypt(header: typeof enc0.header, ciphertext: Uint8Array) {
    return withDeviceLock('thread-x:device-a', async () => {
      const state = store.get('device-a')!;
      await Promise.resolve();
      const result = ratchetDecrypt(sodium, state, header, ciphertext, ad);
      store.set('device-a', result.nextState);
      return result;
    });
  }

  const [resultB, resultA] = await Promise.all([
    lockedDecrypt(enc1.header, enc1.ciphertext),
    lockedDecrypt(enc0.header, enc0.ciphertext),
  ]);

  const finalState = store.get('device-a')!;
  const staleKeyStillPresent = [...finalState.skippedMessageKeys.keys()].some((k) =>
    k.endsWith(':0'),
  );
  log(
    'fixed: no stale/already-consumed key resurfaces after concurrent locked decrypts',
    !staleKeyStillPresent,
  );
  log(
    'both messages still decrypt correctly under the lock',
    utf8Decode(resultA.plaintext) === 'first' && utf8Decode(resultB.plaintext) === 'second',
  );
  log(
    'the store correctly reflects both advances, no lost update',
    finalState.recvMessageNumber === 2,
    `recvMessageNumber=${finalState.recvMessageNumber}`,
  );
}

async function main() {
  await sodium.ready();

  console.log('Bug 1: concurrent encrypts, same device');
  await testConcurrentEncryptsWithoutLock();
  await testConcurrentEncryptsWithLock();

  console.log('Bug 2: concurrent decrypts, same sender device');
  await testConcurrentDecryptsWithoutLock();
  await testConcurrentDecryptsWithLock();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
