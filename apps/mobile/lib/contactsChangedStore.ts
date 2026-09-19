import { create } from 'zustand';

/**
 * A tiny "something changed, please re-sync" signal (punch-list item 1,
 * 2026-09-19) — not a cache of contacts data itself, just a version
 * counter. `profile/[id].tsx`'s "Save to device" action bumps this after
 * a successful `Contact.create()`; `chats.tsx`'s own device-contacts sync
 * effect depends on it, so a newly saved contact's name shows up on the
 * chat list immediately (per the explicit "synchronise contact with
 * device" ask) rather than only after the next full app restart — the
 * Chats tab stays mounted for the whole app session (React Navigation
 * tab persistence), so its own sync `useEffect` would otherwise never
 * re-run once a contact is saved from a different screen.
 */
interface ContactsChangedState {
  version: number;
  bump: () => void;
}

export const useContactsChangedStore = create<ContactsChangedState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}));
