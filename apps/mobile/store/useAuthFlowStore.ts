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
}

export const useAuthFlowStore = create<AuthFlowState>((set) => ({
  pendingPhone: null,
  setPendingPhone: (phone) => set({ pendingPhone: phone }),
}));
