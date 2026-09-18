import * as Updates from 'expo-updates';

/**
 * Eagerly checks for, downloads, and applies an OTA update on cold start,
 * instead of relying on `expo-updates`' default `ON_LOAD` check policy.
 *
 * Found 2026-09-19 while investigating a real user report that a shipped
 * fix (the keyboard-avoidance one, PR #74) still looked broken on-device
 * after the OTA publish succeeded. Root cause: this app never configured
 * `updates.checkAutomatically` in `app.json`, so it ran Expo's default —
 * `ON_LOAD` checks for and *downloads* a new update in the background on
 * every cold start, but keeps running the bundle already on disk until
 * the *next* cold start after that. A user who force-quits and reopens
 * the app exactly once after a publish downloads the fix but is still
 * running the old code; they'd need to fully restart a second time to
 * actually see it — easy to read as "the fix didn't work" when it's
 * really "the fix hasn't been asked to run yet."
 *
 * This makes a session that starts stale self-heal within itself: check,
 * fetch, and reload immediately if a newer update exists, rather than
 * silently deferring to a restart the user has no way to know is needed.
 * Deliberately fire-and-forget, best-effort, and never blocks app
 * startup — `Updates.reloadAsync()` does a full JS-context reload
 * transparently if/when it actually has something newer to switch to,
 * same mechanism `components/ErrorBoundary.tsx`'s own reload button
 * already uses. Guarded by `Updates.isEnabled` (false in local dev/Expo
 * Go, where none of this API is meaningful) rather than `__DEV__` alone,
 * matching Expo's own recommended guard.
 */
export async function checkForOtaUpdateOnLaunch(): Promise<void> {
  if (!Updates.isEnabled) return;

  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return;

    await Updates.fetchUpdateAsync();
    await Updates.reloadAsync();
  } catch (e) {
    // Never let a flaky network check or a fetch failure block the app
    // from opening with whatever it already has — same "fail open on an
    // automatic, silent path" posture every other startup effect in this
    // app already follows (see app/_layout.tsx).
    console.error('checkForOtaUpdateOnLaunch failed:', e);
  }
}
