// Real end-to-end encrypted media (session 37/38 follow-up to docs/21).
//
// A per-attachment symmetric key + nonce, generated fresh for every file
// (never reused — reusing a key+nonce pair for two different plaintexts
// under the same AEAD is exactly the "XOR the two ciphertexts" break this
// codebase's own adversarial e2ee review already flagged once for the
// message ratchet, session.ts's deviceLock.ts). The key/nonce themselves
// travel to the recipient inside the SAME Double Ratchet envelope that
// already carries a message's caption text — see encryptForThread's
// callers in messages.ts for how the plaintext payload becomes
// `{text, mediaKey, mediaNonce}` instead of a bare string when media is
// attached. This module only does the attachment-bytes half: encrypt
// before upload, decrypt after download. No new primitive — the exact
// same XChaCha20-Poly1305 AEAD (SodiumProvider.aeadEncrypt/aeadDecrypt)
// message encryption already uses.
//
// Provider-agnostic, like every other primitive in this directory
// (x3dh.ts, doubleRatchet.ts, safetyNumber.ts) — takes a SodiumProvider
// rather than importing sodiumProviderNative.ts directly, so this is
// Node-testable against sodiumProviderTestAdapter.ts without needing a
// device (mediaCrypto.test.ts).

import { base64ToBytes, bytesToBase64 } from './bytes.ts';
import type { SodiumProvider } from './sodiumProvider.ts';

const MEDIA_KEY_BYTES = 32;
const MEDIA_NONCE_BYTES = 24; // XChaCha20's own nonce size, not XSalsa20's.

export interface MediaKeyMaterial {
  keyBase64: string;
  nonceBase64: string;
}

/** Encrypts a file's raw bytes with a fresh, random key+nonce. The
 * returned `keyMaterial` is never uploaded anywhere — it's meant to be
 * embedded in the message's own encrypted envelope payload (see
 * messages.ts), the one place this attachment's key is ever transmitted. */
export function encryptMediaBytes(
  sodium: SodiumProvider,
  plaintext: Uint8Array,
): { ciphertext: Uint8Array; keyMaterial: MediaKeyMaterial } {
  const key = sodium.randomBytes(MEDIA_KEY_BYTES);
  const nonce = sodium.randomBytes(MEDIA_NONCE_BYTES);
  const ciphertext = sodium.aeadEncrypt(plaintext, null, nonce, key);
  return {
    ciphertext,
    keyMaterial: { keyBase64: bytesToBase64(key), nonceBase64: bytesToBase64(nonce) },
  };
}

/** Inverse of encryptMediaBytes. Throws (AEAD authentication failure) if
 * the ciphertext was tampered with or the key/nonce don't match — never
 * partially decrypts, same guarantee message decryption already has. */
export function decryptMediaBytes(
  sodium: SodiumProvider,
  ciphertext: Uint8Array,
  keyMaterial: MediaKeyMaterial,
): Uint8Array {
  const key = base64ToBytes(keyMaterial.keyBase64);
  const nonce = base64ToBytes(keyMaterial.nonceBase64);
  return sodium.aeadDecrypt(ciphertext, null, nonce, key);
}
