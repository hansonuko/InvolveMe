// Real end-to-end encryption, step 5 (docs/21-E2EE-TECHNICAL-DESIGN.md §5)
//
// A human-verifiable fingerprint derived from both parties' identity keys
// — the actual key-verification UI (Signal/WhatsApp's "verify this
// contact" screen). Not a byte-for-byte reproduction of Signal's own
// numeric-fingerprint algorithm (SHA-512-iterated, 60 digits/12 groups) —
// there's no cross-app compatibility requirement to match it exactly, only
// the two properties that actually matter: both devices in a conversation
// must independently compute the IDENTICAL string from the same key
// material (so it's meaningful to compare over a phone call or in
// person), and changing either party's identity key must change the
// output (so a MITM'd key exchange is visibly different, not silently
// accepted).
//
// Built on hkdfExtract/hkdfExpand (already primitives on SodiumProvider)
// rather than a new raw-hash primitive — react-native-libsodium exposes
// neither a general hash function nor HMAC directly (see sodiumProvider.ts
// and hmacSha256Rfc2104.ts's header comments), but a fixed-salt HKDF over
// the combined key material is exactly as suitable for this: a
// deterministic, one-way, uniformly-distributed derivation, which is all
// a display fingerprint needs.

import { concatBytes } from './bytes';
import type { SodiumProvider } from './sodiumProvider';

const SAFETY_NUMBER_INFO = 'InvolveMe-SafetyNumber-v1';
const OUTPUT_BYTES = 30; // 6 groups x 5 bytes
const GROUP_COUNT = 6;
const BYTES_PER_GROUP = OUTPUT_BYTES / GROUP_COUNT;

export interface IdentityFingerprintInput {
  userId: string;
  identityKeyX25519: Uint8Array;
}

function encodePair(input: IdentityFingerprintInput): Uint8Array {
  const userIdBytes = new TextEncoder().encode(input.userId);
  return concatBytes(input.identityKeyX25519, userIdBytes);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * A stable, human-comparable numeric string, identical on both devices in
 * a conversation regardless of which side ("self" vs "other") called it —
 * the two inputs are canonically ordered before derivation.
 */
export function computeSafetyNumber(
  sodium: SodiumProvider,
  a: IdentityFingerprintInput,
  b: IdentityFingerprintInput,
): string {
  const encodedA = encodePair(a);
  const encodedB = encodePair(b);
  const [first, second] =
    compareBytes(encodedA, encodedB) <= 0 ? [encodedA, encodedB] : [encodedB, encodedA];

  const ikm = concatBytes(first, second);
  const salt = new Uint8Array(32); // zero-filled — this derivation has no secret salt to contribute
  const prk = sodium.hkdfExtract(salt, ikm);
  const okm = sodium.hkdfExpand(prk, SAFETY_NUMBER_INFO, OUTPUT_BYTES);

  const groups: string[] = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    let value = 0;
    for (let i = 0; i < BYTES_PER_GROUP; i++) {
      value = value * 256 + okm[g * BYTES_PER_GROUP + i];
    }
    groups.push(String(value % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}
