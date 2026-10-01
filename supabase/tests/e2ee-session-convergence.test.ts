// Real end-to-end encryption — session convergence after divergence
//
// Regression test for the live bug that made every new message in a real
// thread render as "Message unavailable" on the recipient's device, in both
// directions, permanently.
//
// The cause was `decryptEnvelope` (apps/mobile/lib/e2ee/session.ts) gating
// its X3DH bootstrap branch on `!session`: a device that still held an older
// session ignored every bootstrap its peer sent and kept decrypting against
// the dead session, while its own sends carried no bootstrap for the peer to
// pick up. Once two devices' root keys diverged, neither direction could ever
// recover. Confirmed live in the dev DB before the fix: one participant's
// envelopes were always `x3dh=false` with a ratchet counter climbing 8→17,
// the other's always `x3dh=true` at `n=0` — a peer re-handshaking on every
// single message while the other side never once honored it.
//
// These tests exercise the protocol semantics the fix restores (Signal's
// rule: a message carrying X3DH fields always establishes a new session,
// replacing any existing one), at the same pure-crypto layer as
// e2ee-crypto-core.test.ts — no DB, no network, no device storage.
//
// Run: node supabase/tests/e2ee-session-convergence.test.ts

import { testSodiumProvider as sodium } from '../../apps/mobile/lib/e2ee/sodiumProviderTestAdapter.ts';
import {
  initRatchetAsAlice,
  initRatchetAsBob,
  ratchetDecrypt,
  ratchetEncrypt,
  type RatchetState,
} from '../../apps/mobile/lib/e2ee/doubleRatchet.ts';
import { x3dhInitiate, x3dhRespond, type PrekeyBundle } from '../../apps/mobile/lib/e2ee/x3dh.ts';

let passed = 0;
let failed = 0;

function log(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.error(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

const ad = new TextEncoder().encode('InvolveMe-thread:convergence-test');
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

interface Identity {
  identityX25519: { publicKey: Uint8Array; privateKey: Uint8Array };
  signedPrekey: { publicKey: Uint8Array; privateKey: Uint8Array };
}

function makeIdentity(): Identity {
  return {
    identityX25519: sodium.generateX25519KeyPair(),
    signedPrekey: sodium.generateX25519KeyPair(),
  };
}

function bundleFor(id: Identity): PrekeyBundle {
  return {
    identityKeyEd25519: new Uint8Array(32),
    identityKeyX25519: id.identityX25519.publicKey,
    signedPrekeyPublic: id.signedPrekey.publicKey,
    signedPrekeySignature: new Uint8Array(64),
    oneTimePrekeyPublic: null,
  };
}

/** One outgoing envelope, mirroring the fields the real wire format carries. */
interface Envelope {
  header: { ratchetPublicKey: Uint8Array; previousChainLength: number; messageNumber: number };
  ciphertext: Uint8Array;
  x3dhSenderIdentityKey: Uint8Array | null;
  x3dhSenderEphemeralKey: Uint8Array | null;
}

/** Sender side: bootstraps a fresh session when it has none (carrying X3DH
 * fields), otherwise ratchets forward on the session it already holds —
 * exactly what `encryptForThread` does. */
function send(
  self: Identity,
  peerBundle: PrekeyBundle,
  session: RatchetState | null,
  text: string,
): { envelope: Envelope; nextState: RatchetState } {
  if (!session) {
    const init = x3dhInitiate(sodium, self.identityX25519.privateKey, peerBundle);
    const fresh = initRatchetAsAlice(sodium, init.rootKey, peerBundle.signedPrekeyPublic);
    const out = ratchetEncrypt(sodium, fresh, enc(text), ad);
    return {
      envelope: {
        header: out.header,
        ciphertext: out.ciphertext,
        x3dhSenderIdentityKey: self.identityX25519.publicKey,
        x3dhSenderEphemeralKey: init.ephemeralPublicKey,
      },
      nextState: out.nextState,
    };
  }
  const out = ratchetEncrypt(sodium, session, enc(text), ad);
  return {
    envelope: {
      header: out.header,
      ciphertext: out.ciphertext,
      x3dhSenderIdentityKey: null,
      x3dhSenderEphemeralKey: null,
    },
    nextState: out.nextState,
  };
}

/** The FIXED receive path: try the stored session first, then fall back to
 * honoring the envelope's X3DH bootstrap. Mirrors decryptEnvelope post-fix. */
function receiveFixed(
  self: Identity,
  session: RatchetState | null,
  envelope: Envelope,
): { plaintext: string; nextState: RatchetState } {
  const hasBootstrap = !!envelope.x3dhSenderIdentityKey && !!envelope.x3dhSenderEphemeralKey;

  if (session) {
    try {
      const d = ratchetDecrypt(sodium, session, envelope.header, envelope.ciphertext, ad);
      return { plaintext: dec(d.plaintext), nextState: d.nextState };
    } catch (e) {
      if (!hasBootstrap) throw e;
    }
  }
  if (!hasBootstrap) {
    throw new Error('no session and no X3DH bootstrap fields on this envelope');
  }

  const rootKey = x3dhRespond(sodium, {
    ownIdentityPrivateKeyX25519: self.identityX25519.privateKey,
    ownSignedPrekeyPrivateKey: self.signedPrekey.privateKey,
    ownOneTimePrekeyPrivateKey: null,
    peerIdentityPublicKeyX25519: envelope.x3dhSenderIdentityKey as Uint8Array,
    peerEphemeralPublicKey: envelope.x3dhSenderEphemeralKey as Uint8Array,
  });
  const fresh = initRatchetAsBob(sodium, rootKey, self.signedPrekey);
  const d = ratchetDecrypt(sodium, fresh, envelope.header, envelope.ciphertext, ad);
  return { plaintext: dec(d.plaintext), nextState: d.nextState };
}

/** The OLD receive path, reproduced verbatim to prove it is what wedged the
 * pair: the bootstrap is only ever consulted when no session exists. */
function receiveOldBuggy(
  self: Identity,
  session: RatchetState | null,
  envelope: Envelope,
): { plaintext: string; nextState: RatchetState } {
  let working = session;
  if (!working && envelope.x3dhSenderIdentityKey && envelope.x3dhSenderEphemeralKey) {
    const rootKey = x3dhRespond(sodium, {
      ownIdentityPrivateKeyX25519: self.identityX25519.privateKey,
      ownSignedPrekeyPrivateKey: self.signedPrekey.privateKey,
      ownOneTimePrekeyPrivateKey: null,
      peerIdentityPublicKeyX25519: envelope.x3dhSenderIdentityKey,
      peerEphemeralPublicKey: envelope.x3dhSenderEphemeralKey,
    });
    working = initRatchetAsBob(sodium, rootKey, self.signedPrekey);
  }
  if (!working) throw new Error('no session and no X3DH bootstrap fields on this envelope');
  const d = ratchetDecrypt(sodium, working, envelope.header, envelope.ciphertext, ad);
  return { plaintext: dec(d.plaintext), nextState: d.nextState };
}

/** Builds the exact real-world broken state: Bob holds a session whose root
 * key does not correspond to anything Alice has (what a handshake completed
 * under the pre-412ffad broken crypto left behind). */
function divergedBobSession(bob: Identity): RatchetState {
  const stranger = makeIdentity();
  const init = x3dhInitiate(sodium, stranger.identityX25519.privateKey, bundleFor(bob));
  return initRatchetAsBob(sodium, init.rootKey, bob.signedPrekey);
}

/** A one-slot stand-in for sessionStore.ts's SecureStore-backed load/save/
 * delete, so these tests can observe exactly what a replayed backlog does to
 * the stored session across multiple decryptEnvelope-style calls. */
class SessionSlot {
  state: RatchetState | null;
  constructor(initial: RatchetState | null) {
    this.state = initial;
  }
}

/** Mirrors decryptEnvelope as it stood through #213/#214: ANY decrypt
 * failure with no bootstrap on the envelope deletes the stored session,
 * regardless of whether the failing message belongs to the session's own
 * current epoch or to some older, unrelated one. */
function receiveWithAutoHealOld(self: Identity, slot: SessionSlot, envelope: Envelope): string {
  const hasBootstrap = !!envelope.x3dhSenderIdentityKey && !!envelope.x3dhSenderEphemeralKey;
  const existing = slot.state;

  if (existing) {
    try {
      const d = ratchetDecrypt(sodium, existing, envelope.header, envelope.ciphertext, ad);
      slot.state = d.nextState;
      return dec(d.plaintext);
    } catch (e) {
      if (!hasBootstrap) {
        slot.state = null;
        throw e;
      }
    }
  }
  if (!hasBootstrap) {
    throw new Error('no session and no X3DH bootstrap fields on this envelope');
  }
  const rootKey = x3dhRespond(sodium, {
    ownIdentityPrivateKeyX25519: self.identityX25519.privateKey,
    ownSignedPrekeyPrivateKey: self.signedPrekey.privateKey,
    ownOneTimePrekeyPrivateKey: null,
    peerIdentityPublicKeyX25519: envelope.x3dhSenderIdentityKey as Uint8Array,
    peerEphemeralPublicKey: envelope.x3dhSenderEphemeralKey as Uint8Array,
  });
  const fresh = initRatchetAsBob(sodium, rootKey, self.signedPrekey);
  const d = ratchetDecrypt(sodium, fresh, envelope.header, envelope.ciphertext, ad);
  slot.state = d.nextState;
  return dec(d.plaintext);
}

/** The fix: only auto-heal (delete) when the failing envelope's ratchet key
 * matches the session's OWN current remote key — i.e. this session's own
 * chain failed to decrypt its own next message, the #213 "poisoned from
 * birth" case this mechanism exists for. A message under a different
 * (typically older) ratchet key is left alone: it is expected to be
 * permanently unreadable by design, and must not cost the session its
 * ability to read everything that comes after it. */
function receiveWithAutoHealFixed(self: Identity, slot: SessionSlot, envelope: Envelope): string {
  const hasBootstrap = !!envelope.x3dhSenderIdentityKey && !!envelope.x3dhSenderEphemeralKey;
  const existing = slot.state;

  if (existing) {
    try {
      const d = ratchetDecrypt(sodium, existing, envelope.header, envelope.ciphertext, ad);
      slot.state = d.nextState;
      return dec(d.plaintext);
    } catch (e) {
      const isSameEpoch =
        !!existing.dhRemotePublicKey &&
        Buffer.from(existing.dhRemotePublicKey).equals(
          Buffer.from(envelope.header.ratchetPublicKey),
        );
      if (!hasBootstrap && isSameEpoch) {
        slot.state = null;
      }
      if (!hasBootstrap) throw e;
    }
  }
  if (!hasBootstrap) {
    throw new Error('no session and no X3DH bootstrap fields on this envelope');
  }
  const rootKey = x3dhRespond(sodium, {
    ownIdentityPrivateKeyX25519: self.identityX25519.privateKey,
    ownSignedPrekeyPrivateKey: self.signedPrekey.privateKey,
    ownOneTimePrekeyPrivateKey: null,
    peerIdentityPublicKeyX25519: envelope.x3dhSenderIdentityKey as Uint8Array,
    peerEphemeralPublicKey: envelope.x3dhSenderEphemeralKey as Uint8Array,
  });
  const fresh = initRatchetAsBob(sodium, rootKey, self.signedPrekey);
  const d = ratchetDecrypt(sodium, fresh, envelope.header, envelope.ciphertext, ad);
  slot.state = d.nextState;
  return dec(d.plaintext);
}

async function main() {
  await sodium.ready();
  console.log('\ne2ee session convergence\n');

  // ---------------------------------------------------------------------
  console.log('the old behavior is what wedged a diverged pair');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();

    const staleBob = divergedBobSession(bob);
    const { envelope } = send(alice, bundleFor(bob), null, 'hello from a fresh session');

    log(
      "a diverged peer's stale session cannot read a fresh bootstrap",
      (() => {
        try {
          ratchetDecrypt(sodium, staleBob, envelope.header, envelope.ciphertext, ad);
          return false;
        } catch {
          return true;
        }
      })(),
    );

    let wedged = false;
    try {
      receiveOldBuggy(bob, staleBob, envelope);
    } catch {
      wedged = true;
    }
    log('the old !session-gated path throws even though the envelope carries a bootstrap', wedged);
  }

  // ---------------------------------------------------------------------
  console.log('\nthe fix recovers the same diverged pair');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();

    const staleBob = divergedBobSession(bob);
    const first = send(alice, bundleFor(bob), null, 'hello from a fresh session');

    let aliceSession = first.nextState;
    let bobSession: RatchetState;
    let recovered = false;
    try {
      const r = receiveFixed(bob, staleBob, first.envelope);
      recovered = r.plaintext === 'hello from a fresh session';
      bobSession = r.nextState;
    } catch (e) {
      log('bootstrap is honored over a stale session', false, String(e));
      bobSession = staleBob;
    }
    log('bootstrap is honored over a stale session, recovering the message', recovered);

    // The reply direction must work too — this is what "both sides converge"
    // means, and it is the half that stayed broken in production.
    const reply = send(bob, bundleFor(alice), bobSession, 'reply on the recovered session');
    const gotReply = receiveFixed(alice, aliceSession, reply.envelope);
    log(
      'the recovered session works in the reply direction',
      gotReply.plaintext === 'reply on the recovered session',
    );
    aliceSession = gotReply.nextState;
    bobSession = reply.nextState;

    // And keeps working for several alternating turns afterwards.
    let ok = true;
    for (let i = 0; i < 4; i++) {
      const a = send(alice, bundleFor(bob), aliceSession, `a${i}`);
      const gotA = receiveFixed(bob, bobSession, a.envelope);
      if (gotA.plaintext !== `a${i}`) ok = false;
      aliceSession = a.nextState;
      bobSession = gotA.nextState;

      const b = send(bob, bundleFor(alice), bobSession, `b${i}`);
      const gotB = receiveFixed(alice, aliceSession, b.envelope);
      if (gotB.plaintext !== `b${i}`) ok = false;
      bobSession = b.nextState;
      aliceSession = gotB.nextState;
    }
    log('conversation stays healthy across alternating turns after recovery', ok);
  }

  // ---------------------------------------------------------------------
  console.log('\nthe fix does not disturb a healthy session');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();

    const first = send(alice, bundleFor(bob), null, 'm0');
    const got0 = receiveFixed(bob, null, first.envelope);
    let aliceSession = first.nextState;
    let bobSession = got0.nextState;
    log('initial bootstrap still establishes a session', got0.plaintext === 'm0');

    let ok = true;
    for (let i = 1; i <= 5; i++) {
      const m = send(alice, bundleFor(bob), aliceSession, `m${i}`);
      const got = receiveFixed(bob, bobSession, m.envelope);
      if (got.plaintext !== `m${i}`) ok = false;
      aliceSession = m.nextState;
      bobSession = got.nextState;
    }
    log('a healthy session keeps ratcheting without re-bootstrapping', ok);

    // Out-of-order delivery must still resolve through the skipped-key cache
    // rather than being mistaken for divergence and triggering a re-handshake.
    const s1 = send(alice, bundleFor(bob), aliceSession, 'ooo-1');
    const s2 = send(alice, bundleFor(bob), s1.nextState, 'ooo-2');
    const later = receiveFixed(bob, bobSession, s2.envelope);
    const earlier = receiveFixed(bob, later.nextState, s1.envelope);
    log(
      'out-of-order delivery still resolves via the skipped-key cache',
      later.plaintext === 'ooo-2' && earlier.plaintext === 'ooo-1',
    );
  }

  // ---------------------------------------------------------------------
  console.log('\na message with no session and no bootstrap is still rejected');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();
    const first = send(alice, bundleFor(bob), null, 'establish');
    const got = receiveFixed(bob, null, first.envelope);
    const next = send(alice, bundleFor(bob), first.nextState, 'no bootstrap on this one');

    let threw = false;
    try {
      receiveFixed(bob, null, next.envelope);
    } catch {
      threw = true;
    }
    log('an envelope with neither a session nor a bootstrap throws', threw && !!got);
  }

  // ---------------------------------------------------------------------
  // Live bug, confirmed in the dev DB 2026-10-01: a thread's backlog
  // contains an old message from before the current session existed
  // (permanently unrecoverable by design, per the test above). The old
  // auto-heal path deleted the CURRENT, healthy session the moment it hit
  // that unrelated old message — breaking every newer message that
  // followed it in the same oldest-first replay, even though those newer
  // messages belong to the session that was just destroyed. The real
  // second-device symptom was "Waiting for this message" recurring forever
  // on otherwise-decryptable messages.
  console.log('\nan old, unrelated, unrecoverable message must not break newer messages behind it');
  {
    const alice = makeIdentity();
    const bob = makeIdentity();

    // Bob's CURRENT, perfectly healthy session — established just now.
    const first = send(alice, bundleFor(bob), null, 'current session: hello');
    const got0 = receiveFixed(bob, null, first.envelope);
    let aliceSession = first.nextState;
    const bobSlot = new SessionSlot(got0.nextState);

    // The next message in THIS session's own chain — should decrypt fine.
    const next = send(alice, bundleFor(bob), aliceSession, 'current session: new message');
    aliceSession = next.nextState;

    // An old envelope from a completely unrelated, earlier epoch (a
    // stranger's handshake standing in for "a message sent before this
    // session existed") — permanently unrecoverable, no bootstrap, exactly
    // like a real pre-#214 historical message replayed from the backlog.
    const strangerAlice = makeIdentity();
    const oldEnvelope = send(strangerAlice, bundleFor(bob), null, 'old: unreadable').envelope;
    const oldNonBootstrapEnvelope: Envelope = {
      ...oldEnvelope,
      x3dhSenderIdentityKey: null,
      x3dhSenderEphemeralKey: null,
    };

    // --- OLD behavior: replay oldest-first, exactly like decryptThreadMessages ---
    {
      const slot = new SessionSlot(bobSlot.state);
      let oldFailed = false;
      try {
        receiveWithAutoHealOld(bob, slot, oldNonBootstrapEnvelope);
      } catch {
        oldFailed = true;
      }
      let newFailedToo = false;
      try {
        receiveWithAutoHealOld(bob, slot, next.envelope);
      } catch {
        newFailedToo = true;
      }
      log(
        'reproduced: the old auto-heal path lets an unrelated old message break a newer, healthy one',
        oldFailed && newFailedToo,
      );
    }

    // --- FIXED behavior: same replay, same two envelopes ---
    {
      const slot = new SessionSlot(bobSlot.state);
      let oldFailed = false;
      try {
        receiveWithAutoHealFixed(bob, slot, oldNonBootstrapEnvelope);
      } catch {
        oldFailed = true;
      }
      log('the old message still correctly fails on its own', oldFailed);

      const plaintext = receiveWithAutoHealFixed(bob, slot, next.envelope);
      log(
        'fixed: the newer message in the still-healthy session decrypts fine right behind it',
        plaintext === 'current session: new message',
      );
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
