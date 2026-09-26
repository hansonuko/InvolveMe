// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §1)
//
// X3DH session establishment, implemented from the public spec
// (https://signal.org/docs/specifications/x3dh/), not from any Signal
// source code. Pure functions depending only on the SodiumProvider
// interface — no platform dependency, fully Node-testable via
// sodiumProviderTestAdapter.ts.
//
// KDF(KM) per the spec's §2.2 exactly: HKDF-SHA256 with
//   IKM  = F || KM        (F = 32 bytes of 0xFF, for X25519 — cryptographic
//                           domain separation from XEdDSA, per spec)
//   salt = 32 zero bytes  (zero-filled, length = HashLen for SHA-256)
//   info = a fixed ASCII string identifying this application/protocol use
// Output SK is 32 bytes and becomes the Double Ratchet's initial root key.
//
// Naming follows the spec's Alice/Bob roles: Alice is whoever fetches the
// other device's prekey bundle and sends the first message (the
// initiator); Bob is whoever published that bundle and receives the first
// message (the responder). Either real user can be "Alice" for a given
// handshake — it's a per-conversation-direction role, not a fixed
// identity.

import { concatBytes } from './bytes.ts';
import type { SodiumProvider } from './sodiumProvider.ts';

const X3DH_INFO = 'InvolveMe-X3DH-v1';
const HASH_LEN = 32; // SHA-256 output size in bytes, also X3DH's F length for X25519

export interface PrekeyBundle {
  identityKeyEd25519: Uint8Array;
  identityKeyX25519: Uint8Array;
  signedPrekeyPublic: Uint8Array;
  signedPrekeySignature: Uint8Array;
  oneTimePrekeyPublic: Uint8Array | null;
}

export class InvalidSignedPrekeySignatureError extends Error {
  constructor() {
    super('Signed prekey signature failed verification against the claimed identity key.');
    this.name = 'InvalidSignedPrekeySignatureError';
  }
}

/**
 * Verifies a fetched bundle's signed prekey was genuinely signed by the
 * device claiming to own it, before any of its key material is trusted
 * in a DH computation. Must be called before x3dhInitiate.
 */
export function verifyPrekeyBundle(sodium: SodiumProvider, bundle: PrekeyBundle): void {
  const valid = sodium.verify(
    bundle.signedPrekeySignature,
    bundle.signedPrekeyPublic,
    bundle.identityKeyEd25519,
  );
  if (!valid) {
    throw new InvalidSignedPrekeySignatureError();
  }
}

export interface X3dhInitiatorResult {
  rootKey: Uint8Array;
  ephemeralPublicKey: Uint8Array;
  usedOneTimePrekey: boolean;
}

function deriveRootKey(sodium: SodiumProvider, dhOutputs: Uint8Array[]): Uint8Array {
  const f = new Uint8Array(HASH_LEN).fill(0xff);
  const km = concatBytes(...dhOutputs);
  const ikm = concatBytes(f, km);
  const salt = new Uint8Array(HASH_LEN); // zero-filled
  const prk = sodium.hkdfExtract(salt, ikm);
  return sodium.hkdfExpand(prk, X3DH_INFO, HASH_LEN);
}

/**
 * Alice's side: given Bob's verified prekey bundle, generates a fresh
 * ephemeral keypair and computes the shared root key. Call
 * verifyPrekeyBundle(bundle) first — this function trusts its input.
 */
export function x3dhInitiate(
  sodium: SodiumProvider,
  ownIdentityPrivateKeyX25519: Uint8Array,
  bundle: PrekeyBundle,
): X3dhInitiatorResult {
  const ephemeral = sodium.generateX25519KeyPair();

  const dh1 = sodium.scalarMult(ownIdentityPrivateKeyX25519, bundle.signedPrekeyPublic);
  const dh2 = sodium.scalarMult(ephemeral.privateKey, bundle.identityKeyX25519);
  const dh3 = sodium.scalarMult(ephemeral.privateKey, bundle.signedPrekeyPublic);

  const dhOutputs = [dh1, dh2, dh3];
  const usedOneTimePrekey = bundle.oneTimePrekeyPublic !== null;
  if (bundle.oneTimePrekeyPublic) {
    dhOutputs.push(sodium.scalarMult(ephemeral.privateKey, bundle.oneTimePrekeyPublic));
  }

  return {
    rootKey: deriveRootKey(sodium, dhOutputs),
    ephemeralPublicKey: ephemeral.publicKey,
    usedOneTimePrekey,
  };
}

export interface X3dhResponderParams {
  ownIdentityPrivateKeyX25519: Uint8Array;
  ownSignedPrekeyPrivateKey: Uint8Array;
  /** The private half of whichever one-time prekey id Alice's first message says she consumed, or null if none. */
  ownOneTimePrekeyPrivateKey: Uint8Array | null;
  peerIdentityPublicKeyX25519: Uint8Array;
  peerEphemeralPublicKey: Uint8Array;
}

/**
 * Bob's side: mirrors x3dhInitiate's DH terms from Bob's own key material
 * so both sides land on the identical root key (ECDH commutativity:
 * DH(a_priv, b_pub) === DH(b_priv, a_pub)).
 */
export function x3dhRespond(sodium: SodiumProvider, params: X3dhResponderParams): Uint8Array {
  const dh1 = sodium.scalarMult(
    params.ownSignedPrekeyPrivateKey,
    params.peerIdentityPublicKeyX25519,
  );
  const dh2 = sodium.scalarMult(params.ownIdentityPrivateKeyX25519, params.peerEphemeralPublicKey);
  const dh3 = sodium.scalarMult(params.ownSignedPrekeyPrivateKey, params.peerEphemeralPublicKey);

  const dhOutputs = [dh1, dh2, dh3];
  if (params.ownOneTimePrekeyPrivateKey) {
    dhOutputs.push(
      sodium.scalarMult(params.ownOneTimePrekeyPrivateKey, params.peerEphemeralPublicKey),
    );
  }

  return deriveRootKey(sodium, dhOutputs);
}
