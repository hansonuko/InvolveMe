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
// a shared hmac primitive, because react-native-libsodium's real binding
// does not expose raw SHA-256 or HMAC-SHA256 at all — only a pre-built
// native crypto_kdf_hkdf_sha256_extract/expand pair. The two
// implementations of this interface therefore take genuinely different
// code paths for HKDF (native adapter: delegates directly; test adapter:
// hand-rolled per RFC 5869 on top of libsodium-wrappers' crypto_auth_
// hmacsha256). That's fine *because* both are verified independently
// against RFC 5869's own published test vectors (see hkdfRfc5869.test.ts)
// rather than trusted to agree with each other.

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
