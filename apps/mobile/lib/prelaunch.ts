// Single source of truth for the soft-launch date on web (app.
// involvemechat.com and web.involvemechat.com). Matches
// apps/marketing/lib/prelaunch.ts's own copy exactly (can't share one
// module across the two separate apps/build targets) — if this date ever
// changes, update both files together.
export const LAUNCH_DATE = new Date('2026-11-20T00:00:00');
export const LAUNCH_DATE_LABEL = 'November 20, 2026';

export function isPrelaunch(): boolean {
  return Date.now() < LAUNCH_DATE.getTime();
}

export const PRELAUNCH_SIGNUP_MESSAGE =
  'Complete this signup from November 20 to start using the app.';
