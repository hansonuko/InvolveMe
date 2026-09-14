import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

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
): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!Device.isDevice) {
    // Simulators/emulators can't receive real push notifications — Expo's
    // own getExpoPushTokenAsync throws on these, so this is checked
    // first rather than surfaced as a confusing runtime error.
    return 'unsupported';
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== 'granted') {
    return 'denied';
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined,
  );

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
