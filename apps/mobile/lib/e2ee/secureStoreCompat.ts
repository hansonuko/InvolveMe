// Platform-dispatching seam for E2EE key storage (session 45 continued —
// real WhatsApp-Web-style E2EE on web). Plain, unsuffixed file is Metro's
// default for every platform (iOS/Android here); `secureStoreCompat.web.ts`
// overrides it for web builds — same shape `sodiumProviderPlatform.ts`
// uses, and the same plain-file-plus-`.web.ts`-override convention
// `expo-camera` itself establishes. Only the three functions every E2EE
// storage file in this app actually calls (`getItemAsync`/`setItemAsync`/
// `deleteItemAsync`, all 2-arg — none of this app's call sites ever pass
// `expo-secure-store`'s optional `SecureStoreOptions`) are re-exported;
// not a full `expo-secure-store` re-export.
export { getItemAsync, setItemAsync, deleteItemAsync } from 'expo-secure-store';
