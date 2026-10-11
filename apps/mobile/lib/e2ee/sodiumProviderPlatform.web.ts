// Platform-dispatching seam for the E2EE crypto provider, web half
// (session 45 continued — real WhatsApp-Web-style E2EE on web, not just a
// graceful "not supported" block). `sodiumProviderNative.ts` (the
// production native path) is backed by `react-native-libsodium`, a native
// module with no web build at all. `sodiumProviderTestAdapter.ts` already
// implements the entire `SodiumProvider` interface using
// `libsodium-wrappers-sumo` — a WASM build of real libsodium that runs
// anywhere, previously wired up only for this repo's own Node test suite
// (verified there against RFC 5869's published HKDF test vectors, same
// pure-TS protocol logic in both `x3dh.ts`/`doubleRatchet.ts`). Reused
// here verbatim rather than duplicated — same already-tested
// implementation now also serves real production web traffic. Confirmed
// directly (not assumed) that this interoperates with the native path's
// own `@noble/curves`-based X25519: a libsodium-generated keypair's DH
// output matches byte-for-byte whether computed via `@noble/curves` or
// via libsodium's own `crypto_scalarmult`.
export { testSodiumProvider as platformSodiumProvider } from './sodiumProviderTestAdapter';
