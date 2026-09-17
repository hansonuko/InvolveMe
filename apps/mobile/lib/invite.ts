import { Share } from 'react-native';

/** Single source of truth for the invite message — used both from
 * Settings' generic "Invite a friend" action and from the Contacts tab's
 * per-contact invite (docs/10-UX-REFINEMENT-BACKLOG.md Batch C1), which
 * reuses this exact share-sheet mechanism rather than inventing a second
 * one. Not contacts-aware (no per-recipient personalization) — same fixed
 * message either way, just triggered from two different entry points. */
export const INVITE_MESSAGE =
  'Join me on InvolveMe — a chat app where your time has real value. Every message counts, literally.';

export function shareInvite() {
  return Share.share({ message: INVITE_MESSAGE });
}
