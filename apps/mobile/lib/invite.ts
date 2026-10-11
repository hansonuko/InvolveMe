import { Platform, Share } from 'react-native';

import { withAppLockSuppressed } from '@/lib/appLock';
import { showAlert } from '@/lib/ui/alert';

/** Single source of truth for the invite message — used both from
 * Settings' generic "Invite a friend" action and from the Contacts tab's
 * per-contact invite (docs/10-UX-REFINEMENT-BACKLOG.md Batch C1), which
 * reuses this exact share-sheet mechanism rather than inventing a second
 * one. Not contacts-aware (no per-recipient personalization) — same fixed
 * message either way, just triggered from two different entry points. */
export const INVITE_MESSAGE =
  'Join me on InvolveMe, a chat app where your time has real value. Every message counts, literally.';

/**
 * `Share.share` on web (`react-native-web`) calls the browser's own
 * `navigator.share` — real on mobile Safari/Chrome, but desktop Chrome and
 * Firefox have no such API and it just rejects outright, which surfaced as
 * an unhandled "Share is not supported in this browser" failure once this
 * screen became reachable from `app.involvemechat.com` (desktop is an
 * explicit audience there). Falls back to copying the invite text to the
 * clipboard and confirming via `showAlert` instead of failing silently.
 */
export function shareInvite() {
  if (Platform.OS === 'web') {
    return Share.share({ message: INVITE_MESSAGE }).catch(async () => {
      await navigator.clipboard.writeText(INVITE_MESSAGE);
      showAlert('Invite link copied', 'Paste it anywhere to invite someone to InvolveMe.');
    });
  }
  // The native share sheet backgrounds this app the same way a camera or
  // permission dialog does — bracketed for the same reason (see
  // lib/appLock.ts's header comment).
  return withAppLockSuppressed(() => Share.share({ message: INVITE_MESSAGE }));
}
