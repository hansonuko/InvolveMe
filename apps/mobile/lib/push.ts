import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { withAppLockSuppressed } from '@/lib/appLock';
import { supabase } from '@/lib/supabase';

// Android requires a notification channel to be registered before any
// notification can show with custom sound/importance — a no-op on iOS.
// Done once, at module load, rather than per-registration.
if (Platform.OS === 'android') {
  void Notifications.setNotificationChannelAsync('default', {
    name: 'default',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250, 250, 250],
  });
}

/** Governs whether a notification banner/sound shows while the app is
 * already open and foregrounded — still delivered either way, this only
 * controls the in-app presentation. Registered once at module load. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** "Off" has no dedicated column anywhere (see
 * supabase/functions/_shared/push.ts's header comment) — it's modeled
 * purely as "no row in push_tokens for this user." Toggling notifications
 * off in Settings calls unregisterPushToken(); there's nothing else to
 * flip. */
export async function registerPushToken(
  userId: string,
): Promise<'granted' | 'denied' | 'unsupported' | 'error'> {
  if (!Device.isDevice) {
    // Simulators/emulators can't receive real push notifications — Expo's
    // own getExpoPushTokenAsync throws on these, so this is checked
    // first rather than surfaced as a confusing runtime error.
    return 'unsupported';
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    // Same bracket as the contacts/camera/share-sheet call sites — this OS
    // permission dialog can background this app too (see lib/appLock.ts's
    // header comment).
    const requested = await withAppLockSuppressed(() => Notifications.requestPermissionsAsync());
    status = requested.status;
  }
  if (status !== 'granted') {
    return 'denied';
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  let token: string;
  try {
    // Real-world failure mode, not hypothetical: getExpoPushTokenAsync
    // hits Expo's push service over the network and can throw for
    // anything from a connectivity blip to a misconfigured FCM project —
    // this project's own unregisterPushToken/hasRegisteredPushToken both
    // already guard the identical call; this one, called automatically
    // and silently on every app session restore (see
    // resyncPushTokenIfPermitted / app/_layout.tsx), did not — the
    // strongest concrete lead found for a real "app goes blank and
    // unresponsive" bug report, since an uncaught throw here is an
    // unhandled rejection on a fire-and-forget `void` call with no
    // safety net above it. See components/ErrorBoundary.tsx for the
    // structural fix (this alone isn't sufficient — anything else that
    // ever throws unguarded on that same path would have the same
    // effect), and this fix for the specific one found.
    const result = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    token = result.data;
  } catch (e) {
    console.error('registerPushToken: getExpoPushTokenAsync failed:', e);
    // Distinct from 'unsupported' — that means "this device can't do push
    // at all" (a simulator) and drives a specific "need a real device"
    // message in settings/index.tsx that would be actively misleading
    // here, on a real device that just hit a transient network/service
    // error and should be told to try again instead.
    return 'error';
  }

  const { error } = await supabase.from('push_tokens').upsert({
    token,
    user_id: userId,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
  });
  if (error) {
    console.error('registerPushToken: failed to save token:', error.message);
  }

  return 'granted';
}

/** Called when the user turns notifications off in Settings, and on
 * sign-out (a stale token left behind would otherwise keep receiving
 * pushes addressed to whoever's device this is, for the *previous*
 * account). Best-effort: if this device never had a token (permission
 * was never granted), there's nothing to delete and Supabase's delete
 * is a no-op either way. */
export async function unregisterPushToken(): Promise<void> {
  if (!Device.isDevice) return;

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    await supabase.from('push_tokens').delete().eq('token', token);
  } catch (e) {
    console.error('unregisterPushToken: failed:', e);
  }
}

/** Called on login/app start — re-registers this device's token *only if
 * permission was already granted* (e.g. from a previous session), never
 * prompting. Prompting only ever happens from the explicit Settings
 * toggle (registerPushToken above); this just keeps an already-consented
 * token fresh across app updates/reinstalls without surprising anyone
 * with a permission dialog on launch. */
export async function resyncPushTokenIfPermitted(userId: string): Promise<void> {
  if (!Device.isDevice) return;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return;
  await registerPushToken(userId);
}

/** Whether this device currently holds a registered token — drives the
 * Settings toggle's initial position without re-requesting permission
 * just to check. */
export async function hasRegisteredPushToken(userId: string): Promise<boolean> {
  if (!Device.isDevice) return false;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return false;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const { data, error } = await supabase
      .from('push_tokens')
      .select('token')
      .eq('token', token)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) return false;
    return !!data;
  } catch {
    return false;
  }
}
