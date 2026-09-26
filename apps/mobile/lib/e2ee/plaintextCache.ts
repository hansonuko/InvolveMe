// Real end-to-end encryption, step 5 (docs/21-E2EE-TECHNICAL-DESIGN.md §5)
//
// A durable, on-device store of already-decrypted E2EE message plaintext,
// keyed by message id. Exists because Double Ratchet forward secrecy
// means a message's decryption key is used exactly once and then
// discarded (docs/21 §1) — the *first* successful decrypt is the *only*
// one that will ever be possible, for this message, on this device. This
// app has no other local message database (lib/queries/messages.ts
// always renders directly from what Supabase returns), so without this,
// reopening the app or scrolling back to an already-seen E2EE message
// would find it permanently unreadable.
//
// Deliberately NOT the same thing as _layout.tsx's TanStack Query
// AsyncStorage persister (a general 24h-maxAge cache for "show last-known
// data while offline") — that eviction policy is fine for a wallet
// balance or a thread list, wrong for message history a user reasonably
// expects to still be there next week. This is its own namespace, no
// expiry, using the same already-installed AsyncStorage dependency
// (CLAUDE.md rule #10 — no new dependency for this).

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'e2ee_plaintext_';
const storageKey = (messageId: string) => `${KEY_PREFIX}${messageId}`;

export async function getCachedPlaintext(messageId: string): Promise<string | null> {
  return AsyncStorage.getItem(storageKey(messageId));
}

/** Batch read, for hydrating a whole thread's worth of messages in one round trip instead of one per message. */
export async function getCachedPlaintextBatch(messageIds: string[]): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map();
  const pairs = await AsyncStorage.multiGet(messageIds.map(storageKey));
  const result = new Map<string, string>();
  pairs.forEach(([key, value], i) => {
    if (value !== null) result.set(messageIds[i], value);
  });
  return result;
}

export async function setCachedPlaintext(messageId: string, body: string): Promise<void> {
  await AsyncStorage.setItem(storageKey(messageId), body);
}

/** Called on fn_delete_message_for_everyone — the server scrubs the real content, and a locally-cached plaintext copy of a "deleted" message would defeat the point of that if left behind. */
export async function deleteCachedPlaintext(messageId: string): Promise<void> {
  await AsyncStorage.removeItem(storageKey(messageId));
}
