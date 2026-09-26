// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §1, §7)
//
// Node/WASM-backed SodiumProvider, used ONLY by this package's own test
// suite (x3dh.test.ts, doubleRatchet.test.ts, hkdfRfc5869.test.ts) — never
// imported by the app itself. Backed by libsodium-wrappers-sumo, which is
// Node-runnable (WASM) unlike the production native module. The plain
// "libsodium-wrappers" package (non-sumo) was tried first and rejected —
// verified live, not assumed: its actual installed runtime exposes only a
// minimal function set (crypto_auth, crypto_generichash, crypto_hash,
// crypto_kdf_hkdf_sha256_* constants) and is MISSING crypto_auth_
// hmacsha256, crypto_box_keypair, crypto_scalarmult, crypto_sign_*, and
// crypto_aead_xchacha20poly1305_ietf_* entirely, despite its own
// published .d.ts documenting all of them — that .d.ts describes the
// full/sumo API surface even when attached to the non-sumo package, which
// is misleading. libsodium-wrappers-sumo's runtime was checked the same
// way (imported, awaited .ready, probed for each function directly) and
// does expose everything this module needs. Same protocol logic
// (x3dh.ts, doubleRatchet.ts) runs against this adapter in tests and
// against sodiumProviderNative.ts in the app.
//
// HKDF here is hand-rolled per RFC 5869 (hkdfRfc5869.ts) on top of a
// hand-rolled RFC 2104 HMAC-SHA256 (hmacSha256Rfc2104.ts) built on this
// library's raw crypto_hash_sha256 — not on crypto_auth_hmacsha256, which
// libsodium-wrappers-sumo restricts to a fixed 32-byte key and therefore
// can't take RFC 5869's variable-length (including zero-length) salt
// directly. See hmacSha256Rfc2104.ts's header comment for the full
// reasoning, and sodiumProvider.ts's header comment for why this
// deliberately takes a different code path from the production adapter,
// and why that's safe (both are checked against RFC 5869's own published
// test vectors independently).

import sodium from 'libsodium-wrappers-sumo';
import {
  hkdfExpand as hkdfExpandRfc5869,
  hkdfExtract as hkdfExtractRfc5869,
} from './hkdfRfc5869.ts';
import { hmacSha256 as hmacSha256Rfc2104 } from './hmacSha256Rfc2104.ts';
import type { KeyPair, SodiumProvider } from './sodiumProvider.ts';

function sha256(data: Uint8Array): Uint8Array {
  return sodium.crypto_hash_sha256(data);
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmacSha256Rfc2104(sha256, key, message);
}

export const testSodiumProvider: SodiumProvider = {
  async ready() {
    await sodium.ready;
  },

  generateX25519KeyPair(): KeyPair {
    const { publicKey, privateKey } = sodium.crypto_box_keypair();
    return { publicKey, privateKey };
  },

  scalarMult(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    return sodium.crypto_scalarmult(privateKey, publicKey);
  },

  generateEd25519KeyPair(): KeyPair {
    const { publicKey, privateKey } = sodium.crypto_sign_keypair();
    return { publicKey, privateKey };
  },

  sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
    return sodium.crypto_sign_detached(message, privateKey);
  },

  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
    return sodium.crypto_sign_verify_detached(signature, message, publicKey);
  },

  hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
    return hkdfExtractRfc5869(hmacSha256, salt, ikm);
  },

  hkdfExpand(prk: Uint8Array, info: string, length: number): Uint8Array {
    return hkdfExpandRfc5869(hmacSha256, prk, new TextEncoder().encode(info), length);
  },

  aeadEncrypt(
    plaintext: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array {
    return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, null, nonce, key);
  },

  aeadDecrypt(
    ciphertext: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ciphertext, aad, nonce, key);
  },

  randomBytes(length: number): Uint8Array {
    return sodium.randombytes_buf(length);
  },
};
