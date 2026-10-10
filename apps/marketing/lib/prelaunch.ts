// Single source of truth for the soft-launch date across the marketing
// site. Matches apps/mobile/lib/prelaunch.ts's own copy exactly (can't
// share one module across the two separate apps/build targets) — if this
// date ever changes, update both files together.
//
// No time zone suffix, same convention CountdownTimer.tsx already used for
// the previous (December 1) date: evaluated in whatever time zone each
// visitor's/server's clock is in, which is fine for a day-granularity
// marketing countdown, not a billing-grade cutover.
export const LAUNCH_DATE = new Date('2026-11-20T00:00:00');
export const LAUNCH_DATE_LABEL = 'November 20, 2026';

export function isPrelaunch(): boolean {
  return Date.now() < LAUNCH_DATE.getTime();
}

export const PRELAUNCH_SIGNUP_MESSAGE =
  'Complete this signup from November 20 to start using the app.';
