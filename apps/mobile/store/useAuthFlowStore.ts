import { create } from 'zustand';

/**
 * UI-only state for the phone → OTP hand-off between (auth) screens.
 * Zustand is for local/UI state exclusively — server state (session, wallet
 * balances, messages) goes through Supabase/TanStack Query, never in here.
 * See CLAUDE.md "Working conventions".
 */
interface AuthFlowState {
  pendingPhone: string | null;
  setPendingPhone: (phone: string | null) => void;
  /** Carries the age-gate/Terms-Privacy checkbox state (app/(auth)/index.tsx)
   * to verify.tsx, which writes users.terms_accepted_at once a real user row
   * exists — see supabase/migrations/20260915130000_terms_acceptance.sql. */
  termsAccepted: boolean;
  setTermsAccepted: (accepted: boolean) => void;
}

export const useAuthFlowStore = create<AuthFlowState>((set) => ({
  pendingPhone: null,
  setPendingPhone: (phone) => set({ pendingPhone: phone }),
  termsAccepted: false,
  setTermsAccepted: (accepted) => set({ termsAccepted: accepted }),
}));
