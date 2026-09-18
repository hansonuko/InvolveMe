import { create } from 'zustand';

import { supabase } from '@/lib/supabase';

/**
 * Whether the current session still needs to clear the two-step-
 * verification PIN gate before the auth gate (app/_layout.tsx) lets it
 * into `/(tabs)` — mirrors `lib/onboardingStore.ts`'s own shape and
 * reasoning exactly: `pinVerified` is `null` until checked ("don't
 * redirect on unknown state," same as `needsOnboarding`/`isLoading`), and
 * a device with two-step verification OFF resolves straight to `true`
 * with nothing to gate.
 *
 * This is a *session*-scoped check, not a per-app-foreground one — unlike
 * `lib/appLock.ts`'s biometric gate (which re-locks on every real
 * background/foreground cycle), the PIN is only ever asked once per fresh
 * phone+OTP sign-in, matching WhatsApp's own real behavior (it gates
 * *registering* the number on a device, not every subsequent open — the
 * biometric/passcode app-lock already covers "every subsequent open" for
 * returning sessions on the same device).
 */
interface TwoStepGateState {
  pinVerified: boolean | null;
  checkedForUserId: string | null;
  checkPinStatus: (userId: string) => Promise<void>;
  markVerified: () => void;
  reset: () => void;
}

export const useTwoStepGateStore = create<TwoStepGateState>((set, get) => ({
  pinVerified: null,
  checkedForUserId: null,

  checkPinStatus: async (userId) => {
    if (get().checkedForUserId === userId && get().pinVerified !== null) return;

    try {
      const { data, error } = await supabase
        .from('users')
        .select('two_step_enabled')
        .eq('id', userId)
        .single();

      // Fail open — same posture checkOnboardingStatus's own fix uses
      // (docs/00-SESSION-HANDOFF.md's 2026-09-18 crash re-check): a
      // transient read error here must never permanently lock a real,
      // already-OTP-verified user out of their own account.
      set({
        pinVerified: error ? true : !data?.two_step_enabled,
        checkedForUserId: userId,
      });
    } catch (e) {
      console.error('checkPinStatus failed:', e);
      set({ pinVerified: true, checkedForUserId: userId });
    }
  },

  markVerified: () => set({ pinVerified: true }),

  reset: () => set({ pinVerified: null, checkedForUserId: null }),
}));
