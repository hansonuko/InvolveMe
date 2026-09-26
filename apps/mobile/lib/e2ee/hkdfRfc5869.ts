// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §1)
//
// Hand-rolled HKDF-SHA256 (RFC 5869), parameterized by an HMAC-SHA256
// function rather than depending on a specific libsodium binding. This
// exists because the Node/test SodiumProvider adapter (libsodium-wrappers)
// has no built-in HKDF, only a raw HMAC-SHA256 primitive
// (crypto_auth_hmacsha256) — so HKDF itself must be built here, on top of
// that primitive, exactly as RFC 5869 specifies. Verified against the
// RFC's own published test vectors (§A.1, §A.3) in hkdfRfc5869.test.ts —
// this module is not trusted by construction, it's trusted because it
// reproduces the standard's own answers.
//
// The production SodiumProvider adapter (react-native-libsodium) does NOT
// use this file — it has a real native HKDF-SHA256 binding and calls that
// directly. This module backs the test adapter only.

import { concatBytes } from './bytes.ts';

export type HmacSha256Fn = (key: Uint8Array, message: Uint8Array) => Uint8Array;

const HASH_LEN = 32; // SHA-256 output size in bytes

export function hkdfExtract(
  hmacSha256: HmacSha256Fn,
  salt: Uint8Array,
  ikm: Uint8Array,
): Uint8Array {
  // RFC 5869 §2.2: PRK = HMAC-Hash(salt, IKM)
  return hmacSha256(salt, ikm);
}

export function hkdfExpand(
  hmacSha256: HmacSha256Fn,
  prk: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  // RFC 5869 §2.3: T(0) = empty; T(n) = HMAC-Hash(PRK, T(n-1) | info | n);
  // OKM = first `length` octets of T(1) | T(2) | ...
  if (length <= 0) {
    throw new Error('hkdfExpand: length must be positive.');
  }
  const n = Math.ceil(length / HASH_LEN);
  if (n > 255) {
    throw new Error(
      'hkdfExpand: requested length is too large for HKDF-SHA256 (max 255 * 32 bytes).',
    );
  }

  const okm = new Uint8Array(n * HASH_LEN);
  // Explicit `Uint8Array` annotation (not inferred from `new Uint8Array(0)`,
  // which narrows to the ArrayBuffer-specific generic in newer TS lib
  // versions) — `hmacSha256`'s return type is the more general
  // ArrayBufferLike-flavored `Uint8Array`, and `previousBlock` is
  // reassigned from it on every loop iteration below.
  let previousBlock: Uint8Array = new Uint8Array(0);

  for (let i = 1; i <= n; i++) {
    const input = concatBytes(previousBlock, info, new Uint8Array([i]));
    const block = hmacSha256(prk, input);
    okm.set(block, (i - 1) * HASH_LEN);
    previousBlock = block;
  }

  return okm.slice(0, length);
}
