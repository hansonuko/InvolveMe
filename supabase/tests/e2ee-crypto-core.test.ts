// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §7)
//
// Exhaustive, isolated tests for the X3DH + Double Ratchet crypto core
// (apps/mobile/lib/e2ee/x3dh.ts, doubleRatchet.ts) — pure protocol logic,
// no UI, no server calls, run against the Node/libsodium-wrappers-sumo
// test adapter (sodiumProviderTestAdapter.ts). Per docs/21 §7: "the
// single highest-risk technical component of the whole effort."
//
// Covers: X3DH handshake agreement (with and without a one-time prekey),
// signature-verification rejection of a tampered bundle, Double Ratchet
// round-trip correctness, long single-direction sequences, out-of-order
// delivery via the skipped-message-key cache, alternating senders (forces
// a DH ratchet step every turn), forward secrecy by construction (a used
// message key is never retrievable from the resulting state), tampered-
// ciphertext (AEAD) rejection, and the MAX_SKIP bound.
//
// Run: node --env-file=.env supabase/tests/e2ee-crypto-core.test.ts
// (no DB/network access needed; --env-file is harmless but unnecessary)

import { testSodiumProvider as sodium } from '../../apps/mobile/lib/e2ee/sodiumProviderTestAdapter.ts';
import {
  initRatchetAsAlice,
  initRatchetAsBob,
  MAX_SKIP,
  ratchetDecrypt,
  ratchetEncrypt,
  SkippedTooManyMessagesError,
} from '../../apps/mobile/lib/e2ee/doubleRatchet.ts';
import {
  InvalidSignedPrekeySignatureError,
  verifyPrekeyBundle,
  x3dhInitiate,
  x3dhRespond,
  type PrekeyBundle,
} from '../../apps/mobile/lib/e2ee/x3dh.ts';

let passed = 0;
let failed = 0;

function log(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function expectThrows(fn: () => void, name: string) {
  try {
    fn();
    log(name, false, 'expected a throw, got none');
  } catch {
    log(name, true);
  }
}

interface Device {
  identityEd25519: ReturnType<typeof sodium.generateEd25519KeyPair>;
  identityX25519: ReturnType<typeof sodium.generateX25519KeyPair>;
  signedPrekey: ReturnType<typeof sodium.generateX25519KeyPair>;
  signedPrekeySignature: Uint8Array;
  oneTimePrekey: ReturnType<typeof sodium.generateX25519KeyPair> | null;
}

function makeDevice(withOneTimePrekey: boolean): Device {
  const identityEd25519 = sodium.generateEd25519KeyPair();
  const identityX25519 = sodium.generateX25519KeyPair();
  const signedPrekey = sodium.generateX25519KeyPair();
  const signedPrekeySignature = sodium.sign(signedPrekey.publicKey, identityEd25519.privateKey);
  const oneTimePrekey = withOneTimePrekey ? sodium.generateX25519KeyPair() : null;
  return { identityEd25519, identityX25519, signedPrekey, signedPrekeySignature, oneTimePrekey };
}

function bundleFor(device: Device): PrekeyBundle {
  return {
    identityKeyEd25519: device.identityEd25519.publicKey,
    identityKeyX25519: device.identityX25519.publicKey,
    signedPrekeyPublic: device.signedPrekey.publicKey,
    signedPrekeySignature: device.signedPrekeySignature,
    oneTimePrekeyPublic: device.oneTimePrekey?.publicKey ?? null,
  };
}

async function main() {
  await sodium.ready();

  console.log('X3DH: handshake with a one-time prekey');
  {
    const alice = makeDevice(false);
    const bob = makeDevice(true);
    const bundle = bundleFor(bob);

    verifyPrekeyBundle(sodium, bundle);
    const initResult = x3dhInitiate(sodium, alice.identityX25519.privateKey, bundle);
    log('initiator used the one-time prekey', initResult.usedOneTimePrekey === true);

    const bobRoot = x3dhRespond(sodium, {
      ownIdentityPrivateKeyX25519: bob.identityX25519.privateKey,
      ownSignedPrekeyPrivateKey: bob.signedPrekey.privateKey,
      ownOneTimePrekeyPrivateKey: bob.oneTimePrekey!.privateKey,
      peerIdentityPublicKeyX25519: alice.identityX25519.publicKey,
      peerEphemeralPublicKey: initResult.ephemeralPublicKey,
    });

    log(
      'Alice and Bob derive the identical root key',
      hex(initResult.rootKey) === hex(bobRoot),
      `${hex(initResult.rootKey)} vs ${hex(bobRoot)}`,
    );
  }

  console.log('X3DH: handshake with NO one-time prekey (degraded mode)');
  {
    const alice = makeDevice(false);
    const bob = makeDevice(false);
    const bundle = bundleFor(bob);

    verifyPrekeyBundle(sodium, bundle);
    const initResult = x3dhInitiate(sodium, alice.identityX25519.privateKey, bundle);
    log(
      'initiator correctly reports no one-time prekey used',
      initResult.usedOneTimePrekey === false,
    );

    const bobRoot = x3dhRespond(sodium, {
      ownIdentityPrivateKeyX25519: bob.identityX25519.privateKey,
      ownSignedPrekeyPrivateKey: bob.signedPrekey.privateKey,
      ownOneTimePrekeyPrivateKey: null,
      peerIdentityPublicKeyX25519: alice.identityX25519.publicKey,
      peerEphemeralPublicKey: initResult.ephemeralPublicKey,
    });

    log(
      'Alice and Bob still derive the identical root key',
      hex(initResult.rootKey) === hex(bobRoot),
    );
  }

  console.log('X3DH: a tampered/forged signed prekey signature is rejected');
  {
    const bob = makeDevice(false);
    const attacker = makeDevice(false);
    const forgedBundle: PrekeyBundle = {
      ...bundleFor(bob),
      // Bob's real prekey, but "signed" by a different identity key.
      signedPrekeySignature: sodium.sign(
        bob.signedPrekey.publicKey,
        attacker.identityEd25519.privateKey,
      ),
    };

    let threw = false;
    try {
      verifyPrekeyBundle(sodium, forgedBundle);
    } catch (e) {
      threw = e instanceof InvalidSignedPrekeySignatureError;
    }
    log('verifyPrekeyBundle throws InvalidSignedPrekeySignatureError', threw);
  }

  console.log('X3DH: using the wrong one-time prekey produces a DIFFERENT root key (sanity)');
  {
    const alice = makeDevice(false);
    const bob = makeDevice(true);
    const bundle = bundleFor(bob);
    const initResult = x3dhInitiate(sodium, alice.identityX25519.privateKey, bundle);

    const wrongOneTimePrekey = sodium.generateX25519KeyPair();
    const bobRootWrong = x3dhRespond(sodium, {
      ownIdentityPrivateKeyX25519: bob.identityX25519.privateKey,
      ownSignedPrekeyPrivateKey: bob.signedPrekey.privateKey,
      ownOneTimePrekeyPrivateKey: wrongOneTimePrekey.privateKey, // wrong private key
      peerIdentityPublicKeyX25519: alice.identityX25519.publicKey,
      peerEphemeralPublicKey: initResult.ephemeralPublicKey,
    });

    log(
      'mismatched key material yields a different root key',
      hex(initResult.rootKey) !== hex(bobRootWrong),
    );
  }

  function bootstrapRatchet() {
    const alice = makeDevice(false);
    const bob = makeDevice(false);
    const bundle = bundleFor(bob);
    const initResult = x3dhInitiate(sodium, alice.identityX25519.privateKey, bundle);
    const bobRoot = x3dhRespond(sodium, {
      ownIdentityPrivateKeyX25519: bob.identityX25519.privateKey,
      ownSignedPrekeyPrivateKey: bob.signedPrekey.privateKey,
      ownOneTimePrekeyPrivateKey: null,
      peerIdentityPublicKeyX25519: alice.identityX25519.publicKey,
      peerEphemeralPublicKey: initResult.ephemeralPublicKey,
    });

    let aliceState = initRatchetAsAlice(sodium, initResult.rootKey, bob.signedPrekey.publicKey);
    let bobState = initRatchetAsBob(sodium, bobRoot, bob.signedPrekey);
    return { aliceState, bobState };
  }

  console.log('Double Ratchet: basic round trip, Alice -> Bob -> Alice');
  {
    let { aliceState, bobState } = bootstrapRatchet();
    const ad = utf8('thread:test');

    const enc1 = ratchetEncrypt(sodium, aliceState, utf8('hello bob'), ad);
    aliceState = enc1.nextState;
    const dec1 = ratchetDecrypt(sodium, bobState, enc1.header, enc1.ciphertext, ad);
    bobState = dec1.nextState;
    log("Bob decrypts Alice's first message correctly", utf8Decode(dec1.plaintext) === 'hello bob');

    const enc2 = ratchetEncrypt(sodium, bobState, utf8('hi alice'), ad);
    bobState = enc2.nextState;
    const dec2 = ratchetDecrypt(sodium, aliceState, enc2.header, enc2.ciphertext, ad);
    aliceState = dec2.nextState;
    log("Alice decrypts Bob's reply correctly", utf8Decode(dec2.plaintext) === 'hi alice');
  }

  console.log('Double Ratchet: long single-direction sequence (chain-key advancement)');
  {
    let { aliceState, bobState } = bootstrapRatchet();
    const ad = utf8('thread:test');
    const messages = Array.from({ length: 20 }, (_, i) => `message ${i}`);

    let ok = true;
    for (const msg of messages) {
      const enc = ratchetEncrypt(sodium, aliceState, utf8(msg), ad);
      aliceState = enc.nextState;
      const dec = ratchetDecrypt(sodium, bobState, enc.header, enc.ciphertext, ad);
      bobState = dec.nextState;
      if (utf8Decode(dec.plaintext) !== msg) ok = false;
    }
    log('20 consecutive messages all decrypt correctly in order', ok);
  }

  console.log('Double Ratchet: out-of-order delivery (skipped-message-key cache)');
  {
    let { aliceState, bobState } = bootstrapRatchet();
    const ad = utf8('thread:test');

    const enc0 = ratchetEncrypt(sodium, aliceState, utf8('msg-0'), ad);
    aliceState = enc0.nextState;
    const enc1 = ratchetEncrypt(sodium, aliceState, utf8('msg-1'), ad);
    aliceState = enc1.nextState;
    const enc2 = ratchetEncrypt(sodium, aliceState, utf8('msg-2'), ad);
    aliceState = enc2.nextState;

    // Bob receives message 2 first — messages 0 and 1 must be skipped and cached.
    const dec2 = ratchetDecrypt(sodium, bobState, enc2.header, enc2.ciphertext, ad);
    bobState = dec2.nextState;
    log('out-of-order message 2 decrypts correctly', utf8Decode(dec2.plaintext) === 'msg-2');
    log('messages 0 and 1 are cached as skipped', bobState.skippedMessageKeys.size === 2);

    const dec0 = ratchetDecrypt(sodium, bobState, enc0.header, enc0.ciphertext, ad);
    bobState = dec0.nextState;
    log(
      'late-arriving message 0 decrypts correctly from the skip cache',
      utf8Decode(dec0.plaintext) === 'msg-0',
    );

    const dec1 = ratchetDecrypt(sodium, bobState, enc1.header, enc1.ciphertext, ad);
    bobState = dec1.nextState;
    log(
      'late-arriving message 1 decrypts correctly from the skip cache',
      utf8Decode(dec1.plaintext) === 'msg-1',
    );
    log(
      'skip cache is empty again once all skipped messages arrive',
      bobState.skippedMessageKeys.size === 0,
    );
  }

  console.log('Double Ratchet: alternating senders forces a real DH ratchet step each turn');
  {
    let { aliceState, bobState } = bootstrapRatchet();
    const ad = utf8('thread:test');

    const turns: Array<'alice' | 'bob'> = ['alice', 'bob', 'alice', 'bob'];
    let ok = true;
    const seenRatchetKeys = new Set<string>();
    seenRatchetKeys.add(hex(aliceState.dhSelfPublicKey));

    for (const turn of turns) {
      if (turn === 'alice') {
        const enc = ratchetEncrypt(sodium, aliceState, utf8(`from alice`), ad);
        aliceState = enc.nextState;
        const dec = ratchetDecrypt(sodium, bobState, enc.header, enc.ciphertext, ad);
        bobState = dec.nextState;
        if (utf8Decode(dec.plaintext) !== 'from alice') ok = false;
        seenRatchetKeys.add(hex(enc.header.ratchetPublicKey));
      } else {
        const enc = ratchetEncrypt(sodium, bobState, utf8(`from bob`), ad);
        bobState = enc.nextState;
        const dec = ratchetDecrypt(sodium, aliceState, enc.header, enc.ciphertext, ad);
        aliceState = dec.nextState;
        if (utf8Decode(dec.plaintext) !== 'from bob') ok = false;
        seenRatchetKeys.add(hex(enc.header.ratchetPublicKey));
      }
    }
    log('all 4 alternating messages decrypt correctly', ok);
    log(
      'at least 4 distinct ratchet public keys were used (real DH ratchet steps occurred)',
      seenRatchetKeys.size >= 4,
      `saw ${seenRatchetKeys.size}`,
    );
  }

  console.log('Double Ratchet: forward secrecy by construction');
  {
    let { aliceState, bobState } = bootstrapRatchet();
    const ad = utf8('thread:test');

    const enc = ratchetEncrypt(sodium, aliceState, utf8('secret message'), ad);
    aliceState = enc.nextState;
    const dec = ratchetDecrypt(sodium, bobState, enc.header, enc.ciphertext, ad);
    bobState = dec.nextState;

    // Message 0 was received directly (no skipping needed), so the only
    // place a message key could survive is skippedMessageKeys — and the
    // direct-decrypt path never writes into it for the message it just
    // consumed. An empty cache here means the used key is nowhere in the
    // resulting state at all: the only copy that ever existed is the local
    // `messageKey` variable inside ratchetDecrypt's stack frame, already
    // gone once the function returned.
    log(
      'the consumed message key is not retrievable from the resulting state',
      bobState.skippedMessageKeys.size === 0,
    );
  }

  console.log('Double Ratchet: tampered ciphertext is rejected (AEAD authentication)');
  {
    let { aliceState, bobState } = bootstrapRatchet();
    const ad = utf8('thread:test');

    const enc = ratchetEncrypt(sodium, aliceState, utf8('do not tamper with me'), ad);
    aliceState = enc.nextState;

    const tampered = new Uint8Array(enc.ciphertext);
    tampered[0] ^= 0xff;

    let threw = false;
    try {
      ratchetDecrypt(sodium, bobState, enc.header, tampered, ad);
    } catch {
      threw = true;
    }
    log('decrypting a tampered ciphertext throws rather than returning garbage', threw);

    let threwOnTamperedAad = false;
    try {
      ratchetDecrypt(sodium, bobState, enc.header, enc.ciphertext, utf8('thread:different'));
    } catch {
      threwOnTamperedAad = true;
    }
    log('decrypting with mismatched associated data throws', threwOnTamperedAad);
  }

  console.log('Double Ratchet: MAX_SKIP bounds how many message keys can be skipped');
  {
    let { aliceState, bobState } = bootstrapRatchet();
    const ad = utf8('thread:test');

    let lastEnc;
    for (let i = 0; i < MAX_SKIP + 5; i++) {
      lastEnc = ratchetEncrypt(sodium, aliceState, utf8(`msg-${i}`), ad);
      aliceState = lastEnc.nextState;
    }

    await expectThrows(() => {
      ratchetDecrypt(sodium, bobState, lastEnc!.header, lastEnc!.ciphertext, ad);
    }, 'decrypting a message that would skip more than MAX_SKIP keys throws SkippedTooManyMessagesError');

    try {
      ratchetDecrypt(sodium, bobState, lastEnc!.header, lastEnc!.ciphertext, ad);
    } catch (e) {
      log(
        'the thrown error is specifically SkippedTooManyMessagesError',
        e instanceof SkippedTooManyMessagesError,
      );
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
