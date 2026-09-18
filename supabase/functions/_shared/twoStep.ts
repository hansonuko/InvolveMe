// _shared/twoStep.ts — hashing, PIN-format validation, and brute-force
// lockout logic shared by every two-step-verification Edge Function
// (set-two-step-pin, disable-two-step, verify-two-step-pin). One copy
// rather than duplicated per function, since a lockout bug matters
// identically wherever it's checked.

// A 6-digit PIN is only ~1M combinations — these two constants are the
// entire defense against guessing it. Not config (pricing_config is for
// money, this isn't) — a plain, documented constant, same posture
// find-users-by-phones' own MAX_PHONES_PER_CALL uses for its own
// non-pricing limit.
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// Punch-list item 2's forgotten-PIN design (see the migration's own header
// comment for the full reasoning): a fresh OTP alone must never clear the
// PIN, since OTP access is exactly what two-step verification exists to
// add a second factor on top of. This cooldown is the real fallback.
export const TWO_STEP_RESET_COOLDOWN_DAYS = 7;

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

export async function hashPin(pin: string, pepper: string): Promise<string> {
  const data = new TextEncoder().encode(`${pin}:${pepper}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface LockoutFields {
  two_step_failed_attempts: number;
  two_step_locked_until: string | null;
}

/** `null` if not currently locked, otherwise the ISO timestamp it unlocks
 * at — checked before ever comparing a submitted PIN against the stored
 * hash, so a locked-out caller can't use response timing/behavior to
 * learn anything about whether their guess would've been right. */
export function currentlyLockedUntil(state: LockoutFields): string | null {
  if (state.two_step_locked_until && new Date(state.two_step_locked_until) > new Date()) {
    return state.two_step_locked_until;
  }
  return null;
}

/** DB fields to write after a failed PIN attempt — locks out for
 * `LOCKOUT_MINUTES` once `MAX_FAILED_ATTEMPTS` is reached, resetting the
 * counter for the next window rather than letting it climb unbounded. */
export function fieldsAfterFailedAttempt(currentAttempts: number): LockoutFields {
  const attempts = currentAttempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    return {
      two_step_failed_attempts: 0,
      two_step_locked_until: new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString(),
    };
  }
  return { two_step_failed_attempts: attempts, two_step_locked_until: null };
}

/** DB fields to write after a successful PIN check — always clears any
 * lockout state, including a stale `locked_until` that's already expired. */
export const fieldsAfterSuccess: LockoutFields = {
  two_step_failed_attempts: 0,
  two_step_locked_until: null,
};
