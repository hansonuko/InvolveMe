// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §1, §5)
//
// Production SodiumProvider, backed by react-native-libsodium (native
// module — X25519/Ed25519/AEAD/random are thin native calls; HKDF-SHA256
// uses that library's real native crypto_kdf_hkdf_sha256_extract/expand
// binding directly, not the hand-rolled RFC 5869 implementation in
// hkdfRfc5869.ts, which backs the Node test adapter instead). See
// sodiumProvider.ts's header comment for why the two adapters take
// different code paths for HKDF and why that's safe.
//
// NOT imported by any Node test in this repo (react-native-libsodium is a
// native module and cannot run outside the RN runtime) — only by the app
// itself. Residual risk, recorded honestly: this file's HKDF path has not
// been verified against RFC 5869 test vectors from this session, because
// doing so requires the actual on-device/RN runtime. Before this ships to
// real users, run a one-off on-device sanity check comparing this
// provider's hkdfExtract/hkdfExpand output against the same RFC 5869
// vectors hkdfRfc5869.test.ts already checks the Node adapter against.

import sodium from 'react-native-libsodium';
import type { KeyPair, SodiumProvider } from './sodiumProvider.ts';

export const nativeSodiumProvider: SodiumProvider = {
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
    return sodium._unstable_crypto_kdf_hkdf_sha256_extract(ikm, salt);
  },

  hkdfExpand(prk: Uint8Array, info: string, length: number): Uint8Array {
    return sodium._unstable_crypto_kdf_hkdf_sha256_expand(prk, info, length);
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
