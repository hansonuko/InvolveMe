import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface PendingTopupState {
  pendingTopupId: string | null;
  amountKobo: number | null;
  setPendingTopup: (topupId: string, amountKobo: number) => void;
  clearPendingTopup: () => void;
}

/**
 * The one piece of state in this app that genuinely needs to survive a
 * full JS-context reload, not just a re-derivation from the server on next
 * launch — found investigating a real report (session 45 continued): a
 * mobile browser backgrounding `app.involvemechat.com` can force a full
 * page reload at any point to reclaim memory (a real platform behavior,
 * not a bug here), and `BuyCreditModal`'s own in-progress top-up tracking
 * (`useBuyCredit()`'s mutation result, `lib/queries/wallet.ts`) lives
 * purely in memory. The instant that reload happens mid-transfer, there is
 * no record anywhere that a top-up was ever started — the credit still
 * lands eventually (the webhook/cron backstop, see `useTopupStatus`'s own
 * header comment), but nothing client-side is watching for it, and the
 * user has no way to tell.
 *
 * The first `persist`-backed Zustand store in this app — every existing
 * store (`onboardingStore.ts`, `twoStepGateStore.ts`) is plain in-memory,
 * re-derived from the server each session, which works for those because
 * the server is the actual source of truth for *that* state. It can't
 * help here: nothing server-side knows which top-up id *this device*
 * considers "the one I'm waiting on" — that's purely a client bookmark.
 */
export const usePendingTopupStore = create<PendingTopupState>()(
  persist(
    (set) => ({
      pendingTopupId: null,
      amountKobo: null,
      setPendingTopup: (topupId, amountKobo) => set({ pendingTopupId: topupId, amountKobo }),
      clearPendingTopup: () => set({ pendingTopupId: null, amountKobo: null }),
    }),
    {
      name: 'involveme-pending-topup',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
