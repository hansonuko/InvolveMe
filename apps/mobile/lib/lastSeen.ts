import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { supabase } from '@/lib/supabase';

// Comfortably longer than the heartbeat interval below so one missed tick
// (a slow network round trip, a brief background blip) doesn't flip
// someone to "offline" spuriously — see the migration's own comment for
// why this is a plain timestamp instead of a Realtime Presence channel.
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const ONLINE_THRESHOLD_MS = 45_000;

async function pingLastSeen(userId: string) {
  // Best-effort — same "never block or surface a failure for this" posture
  // resyncPushTokenIfPermitted/registerDeviceFingerprint already use for
  // silent, automatic, no-user-visible-effect background writes.
  try {
    await supabase
      .from('users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', userId);
  } catch {
    // Next heartbeat or foreground event will catch up.
  }
}

/** Keeps `users.last_seen_at` fresh while the app is open — on every
 * foreground transition, plus a periodic heartbeat while actively in the
 * foreground. Mounted once at the app root (`app/_layout.tsx`), same
 * pattern as the push-token resync / device-fingerprint registration
 * effects already there. */
export function useLastSeenHeartbeat(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;

    void pingLastSeen(userId);

    let interval: ReturnType<typeof setInterval> | null = null;
    const startInterval = () => {
      if (interval) return;
      interval = setInterval(() => void pingLastSeen(userId), HEARTBEAT_INTERVAL_MS);
    };
    const stopInterval = () => {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
    };

    startInterval();

    const handleAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') {
        void pingLastSeen(userId);
        startInterval();
      } else {
        stopInterval();
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      stopInterval();
      subscription.remove();
    };
  }, [userId]);
}
