// Real end-to-end encryption residual gap #2 (docs/00-SESSION-HANDOFF.md
// session 35 "Next session" list) — safety-number change detection.
// safetyNumber.ts already computes the human-verifiable fingerprint on
// demand; on its own that only protects a user who happens to re-open
// that screen and remembers what the number used to say. This module adds
// the other half: remembering the partner's identity key we last saw, so
// a rotation (re-registered device, reinstall, or a real MITM'd key
// exchange — this alone can't tell which) can be surfaced automatically
// instead of relying on the user to notice.
//
// Trust-on-first-use, same model Signal/WhatsApp/every other safety-number
// scheme actually ships: the first key ever seen for a partner is stored
// with nothing to compare against, so no alert fires. AsyncStorage, not
// expo-secure-store — this holds the PARTNER's public identity key, not
// anything of this device's own, and public key material is deliberately
// not secret (docs/21 §2's own classification, applied here the same way
// identity.ts applies the opposite one to the device's own keypairs).

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'e2ee_known_identity_key_';
const storageKey = (partnerId: string) => `${KEY_PREFIX}${partnerId}`;

/** `null` means no key has ever been recorded for this partner — the caller's cue to store the current one with no alert (first sighting, nothing to compare against). */
export async function getKnownIdentityKey(partnerId: string): Promise<string | null> {
  return AsyncStorage.getItem(storageKey(partnerId));
}

/** Called both on first sighting and after the user acknowledges a change — either way, this becomes the new baseline the next check compares against. */
export async function setKnownIdentityKey(
  partnerId: string,
  identityKeyHex: string,
): Promise<void> {
  await AsyncStorage.setItem(storageKey(partnerId), identityKeyHex);
}
