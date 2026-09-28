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

// "Messages here are end-to-end encrypted" in-chat system notice (session
// 37) — WhatsApp shows this once at the top of a conversation, then again
// after a long stretch of silence, rather than as a permanently-fixed
// header banner. Keyed per THREAD (not per partner like the identity key
// above) since the notice is about a specific conversation's own history,
// not the partner relationship in the abstract.

const NOTICE_KEY_PREFIX = 'e2ee_notice_last_shown_at_';
const noticeStorageKey = (threadId: string) => `${NOTICE_KEY_PREFIX}${threadId}`;
const NOTICE_RESHOW_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // ~1 month

/** Whether the in-chat "protected" system notice should show right now for
 * this thread — true the first time this thread is ever opened as
 * e2ee-active, and again once ~30 days have passed since it last showed
 * (a long-quiet conversation resurfacing the reminder, same as WhatsApp). */
export async function shouldShowE2eeNotice(threadId: string): Promise<boolean> {
  const lastShownRaw = await AsyncStorage.getItem(noticeStorageKey(threadId));
  if (!lastShownRaw) return true;
  const lastShownAt = Number(lastShownRaw);
  if (!Number.isFinite(lastShownAt)) return true;
  return Date.now() - lastShownAt >= NOTICE_RESHOW_AFTER_MS;
}

/** Marks the notice as shown now — resets the ~30-day reshow clock. */
export async function markE2eeNoticeShown(threadId: string): Promise<void> {
  await AsyncStorage.setItem(noticeStorageKey(threadId), String(Date.now()));
}
