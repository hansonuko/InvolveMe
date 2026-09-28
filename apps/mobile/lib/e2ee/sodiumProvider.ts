// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §1, §5)
//
// This interface is the seam between the Double Ratchet / X3DH protocol
// logic (x3dh.ts, doubleRatchet.ts — pure TS, no platform dependency) and
// whichever concrete libsodium binding actually supplies the primitives.
// Two implementations exist:
//   - sodiumProviderNative.ts   (production — react-native-libsodium)
//   - a libsodium-wrappers-backed adapter, Node/WASM, used only by this
//     package's own test suite (not shipped to the app)
// Same protocol code runs against both, so the highest-risk part of this
// feature (the ratchet state machine itself) is fully Node-testable even
// though the primitives it depends on in production are a native module
// that cannot run under plain Node.
//
// hkdfExtract/hkdfExpand are first-class methods here, not decomposed into
// a shared hmac primitive, purely because that's the natural interface
// shape for callers (x3dh.ts/doubleRatchet.ts) — as of session 37, BOTH
// implementations of this interface actually take the SAME code path
// underneath: hand-rolled RFC 5869 HKDF (hkdfRfc5869.ts) on top of a
// hand-rolled RFC 2104 HMAC-SHA256 (hmacSha256Rfc2104.ts), fed by a real
// SHA-256 implementation each adapter sources differently (native adapter:
// `@noble/hashes`, pure JS; test adapter: libsodium-wrappers-sumo's
// crypto_hash_sha256). This used to differ — the native adapter called
// react-native-libsodium's own `_unstable_crypto_kdf_hkdf_sha256_extract/
// expand` directly — until session 37 found that path (and, far more
// seriously, `scalarMult`'s `crypto_scalarmult` call) genuinely does not
// exist in that library's real native binary at all, only in the generic
// web-facing type declarations `tsc` happens to read. See
// sodiumProviderNative.ts's own header comment for the full incident.
// Both HKDF code paths are still verified independently against RFC
// 5869's own published test vectors (hkdfRfc5869.test.ts) rather than
// trusted to agree with each other just because they now share logic.

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface SodiumProvider {
  ready(): Promise<void>;

  generateX25519KeyPair(): KeyPair;
  /** Raw X25519 ECDH. Returns the shared secret (not yet KDF'd). */
  scalarMult(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;

  generateEd25519KeyPair(): KeyPair;
  sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;

  /** HKDF-Extract (RFC 5869) with SHA-256. Returns a 32-byte PRK. */
  hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array;
  /**
   * HKDF-Expand (RFC 5869) with SHA-256. `info` is always a plain ASCII
   * domain-separation label in this codebase (never raw/binary context),
   * which is also the only shape react-native-libsodium's native binding
   * accepts for this parameter.
   */
  hkdfExpand(prk: Uint8Array, info: string, length: number): Uint8Array;

  aeadEncrypt(
    plaintext: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;
  aeadDecrypt(
    ciphertext: Uint8Array,
    aad: Uint8Array | null,
    nonce: Uint8Array,
    key: Uint8Array,
  ): Uint8Array;

  randomBytes(length: number): Uint8Array;
}
