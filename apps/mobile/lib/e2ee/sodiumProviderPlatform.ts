// Platform-dispatching seam for the E2EE crypto provider (session 45
// continued — real WhatsApp-Web-style E2EE on web). Plain, unsuffixed
// file is Metro's default for every platform (iOS/Android here);
// `sodiumProviderPlatform.web.ts` overrides it specifically for web
// builds — the exact same plain-file-plus-`.web.ts`-override shape
// `expo-camera` itself uses (`ExpoCameraManager.ts`/`.web.ts`), not a new
// pattern invented for this. No `Platform.OS` branching needed at any
// call site, and `tsc` (which has no platform awareness) resolving this
// plain file for type-checking is still correct either way, since both
// implementations satisfy the identical `SodiumProvider` interface. See
// the `.web.ts` sibling's own header comment for the web half of this
// story.
export { nativeSodiumProvider as platformSodiumProvider } from './sodiumProviderNative';
