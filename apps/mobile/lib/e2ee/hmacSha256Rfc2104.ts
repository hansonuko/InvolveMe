// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §1)
//
// Hand-rolled HMAC-SHA256 (RFC 2104), parameterized by a raw SHA-256 hash
// function. Exists because libsodium-wrappers-sumo's own
// crypto_auth_hmacsha256 is NOT a general HMAC — verified live, not
// assumed: it throws "invalid key length" for any key that isn't exactly
// crypto_auth_hmacsha256_KEYBYTES (32) bytes. RFC 5869's HKDF-Extract uses
// the salt AS the HMAC key, and salt is explicitly variable-length in the
// standard — RFC 5869's own Test Case 1 uses a 13-byte salt and Test
// Case 3 uses a zero-length salt, neither of which crypto_auth_hmacsha256
// can accept directly. This module implements the real, general RFC 2104
// construction (key hashing/zero-padding included) on top of
// crypto_hash_sha256 instead, and hkdfRfc5869.test.ts's exact
// reproduction of both those RFC 5869 vectors is what verifies this
// module's key-padding logic is correct, including the short-key and
// zero-length-key edge cases.
//
// Used only by the Node test adapter (sodiumProviderTestAdapter.ts) — the
// production adapter never needs this, since react-native-libsodium's
// native HKDF binding handles variable-length salt internally.

import { concatBytes } from './bytes.ts';

const BLOCK_SIZE = 64; // SHA-256 block size in bytes

export type Sha256Fn = (data: Uint8Array) => Uint8Array;

function xorPad(key: Uint8Array, pad: number): Uint8Array {
  const out = new Uint8Array(BLOCK_SIZE);
  for (let i = 0; i < BLOCK_SIZE; i++) {
    out[i] = (key[i] ?? 0) ^ pad;
  }
  return out;
}

export function hmacSha256(sha256: Sha256Fn, key: Uint8Array, message: Uint8Array): Uint8Array {
  const normalizedKey = key.length > BLOCK_SIZE ? sha256(key) : key;

  const innerPadded = xorPad(normalizedKey, 0x36);
  const outerPadded = xorPad(normalizedKey, 0x5c);

  const innerHash = sha256(concatBytes(innerPadded, message));
  return sha256(concatBytes(outerPadded, innerHash));
}
