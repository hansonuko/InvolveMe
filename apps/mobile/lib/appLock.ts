import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export type AppLockState = 'unlocked' | 'locked';

// The biometric/passcode system sheet itself briefly backgrounds this app
// (it's a system overlay on both platforms), which fires the same
// AppState 'active' transition a real "user switched back to InvolveMe"
// does. Without this guard, a *successful* unlock could be immediately
// re-locked by that same transition's own foreground event arriving a
// moment after `authenticateAsync` resolves — this app has no real
// device/simulator available to reproduce and tune the exact timing, so
// a short, deliberately generous cooldown is used instead of a tight one.
const REFOREGROUND_GRACE_MS = 1500;

/**
 * Gates access to an already-valid Supabase session behind the device's
 * own OS-level biometric/passcode (docs/10-UX-REFINEMENT-BACKLOG.md Batch
 * E1) — never a custom in-app PIN, which would be weaker and more code to
 * secure than delegating to whatever lock the device already has. Purely
 * client-side, per that spec: no new server-side auth concept, no OTP
 * call from here. Re-locks once per app-foreground transition (not once
 * per screen, per the batch's own scoping note), using the same
 * AppState-driven pattern `lib/lastSeen.ts` already established for a
 * different purpose.
 *
 * A device with no lock method configured at all
 * (`SecurityLevel.NONE` — no biometric enrolled and no passcode set)
 * skips the gate entirely rather than forcing a fresh OTP verification:
 * this hook's contract is "delegate to whatever lock the device already
 * has," and a device with literally no lock has nothing to delegate to.
 * (The original scoping note also floated "fall back to full OTP
 * re-verification" as an option for this case — not taken, since it
 * would reintroduce a server round-trip the same spec calls unnecessary
 * elsewhere: "no new server-side auth concept needed, purely a
 * client-side gate.")
 */
export function useAppLock(hasSession: boolean) {
  const [state, setState] = useState<AppLockState>('unlocked');
  const checkingRef = useRef(false);
  const lastUnlockAtRef = useRef(0);

  const attemptUnlock = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        setState('unlocked');
        return;
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock InvolveMe',
      });

      if (result.success) {
        lastUnlockAtRef.current = Date.now();
        setState('unlocked');
      } else {
        setState('locked');
      }
    } catch (e) {
      // Fail open rather than permanently locking someone out of their
      // own already-valid session over a transient native-module error —
      // this gate is a hardening layer on top of the OTP-backed session,
      // not the only thing standing between the app and the account.
      console.error('useAppLock: authentication check failed:', e);
      setState('unlocked');
    } finally {
      checkingRef.current = false;
    }
  }, []);

  // Cold start / session just became available -> locked until proven
  // otherwise. Nothing to protect (and nothing shown) before there's a
  // session at all.
  useEffect(() => {
    if (!hasSession) {
      setState('unlocked');
      return;
    }
    setState('locked');
    void attemptUnlock();
  }, [hasSession, attemptUnlock]);

  useEffect(() => {
    if (!hasSession) return;

    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (checkingRef.current) return;
      if (Date.now() - lastUnlockAtRef.current < REFOREGROUND_GRACE_MS) return;

      setState('locked');
      void attemptUnlock();
    });

    return () => subscription.remove();
  }, [hasSession, attemptUnlock]);

  return { locked: state === 'locked', retry: attemptUnlock };
}
