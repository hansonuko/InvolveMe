import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

export type AppLockState = 'unlocked' | 'locked';

// How long a suppression (see withAppLockSuppressed) stays in effect after
// the wrapped action resolves — the OS-level UI it triggered (camera,
// permission dialog, share sheet, biometric prompt) can send its own
// trailing AppState 'active' event slightly *after* the awaited promise
// settles, not synchronously with it.
const SUPPRESSION_TRAIL_MS = 1500;

let suppressionDepth = 0;
let suppressionTrailTimeout: ReturnType<typeof setTimeout> | null = null;

function isLockSuppressed() {
  return suppressionDepth > 0 || suppressionTrailTimeout !== null;
}

/**
 * Brackets any action that legitimately backgrounds/foregrounds this app
 * without the user actually having left it: opening the camera or photo
 * library (`StatusComposer`), an OS contacts/notifications permission
 * dialog (`lib/contacts.ts`, `lib/push.ts`), a share sheet (`lib/invite.ts`),
 * or the biometric prompt itself (`attemptUnlock` below).
 *
 * Every one of these fires the exact same `AppState` 'active' transition a
 * real "switched back to InvolveMe" does — on Android in particular, a
 * system camera/contacts picker is a genuinely separate activity, so the
 * host app really does reach `'background'`, not just a transient
 * `'inactive'` blip a same-process/previous-state heuristic could filter
 * out. Before this existed, `useAppLock`'s re-lock check couldn't tell
 * these apart from a real app-switch, which is what was surfacing as three
 * separate bug reports (phone-entry screen flashing back in, the app
 * appearing to reload itself, the Contacts tab bouncing back to the chat
 * list) before the shared root cause was found — see
 * `docs/00-SESSION-HANDOFF.md`'s 2026-09-17 punch list items 2/8/9/10.
 */
export async function withAppLockSuppressed<T>(action: () => Promise<T>): Promise<T> {
  suppressionDepth += 1;
  if (suppressionTrailTimeout) {
    clearTimeout(suppressionTrailTimeout);
    suppressionTrailTimeout = null;
  }
  try {
    return await action();
  } finally {
    suppressionDepth -= 1;
    if (suppressionDepth === 0) {
      suppressionTrailTimeout = setTimeout(() => {
        suppressionTrailTimeout = null;
      }, SUPPRESSION_TRAIL_MS);
    }
  }
}

/**
 * Gates access to an already-valid Supabase session behind the device's
 * own OS-level biometric/passcode (docs/10-UX-REFINEMENT-BACKLOG.md Batch
 * E1) — never a custom in-app PIN, which would be weaker and more code to
 * secure than delegating to whatever lock the device already has. Purely
 * client-side, per that spec: no new server-side auth concept, no OTP
 * call from here. Re-locks once per genuine app-foreground transition
 * (not once per screen, per the batch's own scoping note, and not for a
 * transition this hook was told to ignore — see withAppLockSuppressed
 * above), using the same AppState-driven pattern `lib/lastSeen.ts`
 * already established for a different purpose.
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

  const attemptUnlock = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        setState('unlocked');
        return;
      }

      // Suppressed for the duration of the OS prompt (and its trailing
      // dismissal transition) so the prompt's own background/foreground
      // cycle can't re-enter this same function and re-lock a successful
      // — or even a just-cancelled — attempt.
      const result = await withAppLockSuppressed(() =>
        LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock InvolveMe' }),
      );

      setState(result.success ? 'unlocked' : 'locked');
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
      if (isLockSuppressed()) return;

      setState('locked');
      void attemptUnlock();
    });

    return () => subscription.remove();
  }, [hasSession, attemptUnlock]);

  return { locked: state === 'locked', retry: attemptUnlock };
}
