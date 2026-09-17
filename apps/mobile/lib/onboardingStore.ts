import { create } from 'zustand';

import { supabase } from '@/lib/supabase';

/**
 * Whether the current session's user still needs to run (auth)/onboarding
 * (docs/10-UX-REFINEMENT-BACKLOG.md Batch E's E2 item) — `null` means
 * "not checked yet", the same "unknown, don't redirect either way" state
 * `useSession`'s `isLoading` plays for the session itself.
 *
 * Lives in a small Zustand store rather than local state in app/_layout.tsx
 * because the onboarding screen itself needs to flip this to `false` the
 * moment fn_complete_onboarding succeeds — otherwise the auth gate's own
 * effect would immediately bounce the user straight back to /onboarding
 * before they ever see the welcome step, racing against the screen's own
 * navigation. UI-only state, not server data, so Zustand (not TanStack
 * Query) per CLAUDE.md's "Working conventions" — same category as
 * useAuthFlowStore's phone/OTP hand-off.
 */
interface OnboardingStatusState {
  needsOnboarding: boolean | null;
  checkedForUserId: string | null;
  setNeedsOnboarding: (value: boolean | null) => void;
  checkOnboardingStatus: (userId: string) => Promise<void>;
  reset: () => void;
}

export const useOnboardingStatusStore = create<OnboardingStatusState>((set, get) => ({
  needsOnboarding: null,
  checkedForUserId: null,

  setNeedsOnboarding: (value) => set({ needsOnboarding: value }),

  checkOnboardingStatus: async (userId) => {
    if (get().checkedForUserId === userId && get().needsOnboarding !== null) return;

    const { data, error } = await supabase
      .from('users')
      .select('display_name')
      .eq('id', userId)
      .single();

    // Fail open to the chats list rather than trap a real, already-verified
    // user behind onboarding on a transient read error.
    set({
      needsOnboarding: error ? false : data?.display_name == null,
      checkedForUserId: userId,
    });
  },

  reset: () => set({ needsOnboarding: null, checkedForUserId: null }),
}));
