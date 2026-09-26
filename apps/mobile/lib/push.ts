import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { withAppLockSuppressed } from '@/lib/appLock';
import { supabase } from '@/lib/supabase';

// Android requires a notification channel to be registered before any
// notification can show with custom sound/importance — a no-op on iOS.
// Done once, at module load, rather than per-registration. MAX (not
// DEFAULT) is what actually earns a heads-up banner + sound while the
// phone is unlocked elsewhere — WhatsApp's own message notifications are
// heads-up by default, and a chat app whose notifications don't interrupt
// is the "isn't working" complaint in practice even when delivery itself
// is fine.
if (Platform.OS === 'android') {
  void Notifications.setNotificationChannelAsync('default', {
    name: 'default',
    importance: Notifications.AndroidImportance.MAX,
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

/** Persisted separately from "is there a push_tokens row" (the actual on/
 * off source of truth — see this file's other header comments) because
 * that alone can't distinguish "never asked" from "the user explicitly
 * turned this off in Settings." Without this flag, `syncPushTokenOnLaunch`
 * would silently re-register a token on the very next app open after an
 * explicit opt-out, the moment OS permission (still granted — turning off
 * the in-app toggle can't revoke that) came back into view. Local-only,
 * AsyncStorage — same "cheap boolean flag, no need for a full store"
 * posture as this app's other single-value local preferences. */
const PUSH_OPT_OUT_KEY = 'push_notifications_opted_out';

async function getPushOptedOut(): Promise<boolean> {
  return (await AsyncStorage.getItem(PUSH_OPT_OUT_KEY)) === 'true';
}

async function setPushOptedOut(optedOut: boolean): Promise<void> {
  if (optedOut) {
    await AsyncStorage.setItem(PUSH_OPT_OUT_KEY, 'true');
  } else {
    await AsyncStorage.removeItem(PUSH_OPT_OUT_KEY);
  }
}

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
    // syncPushTokenOnLaunch / app/_layout.tsx), did not — the
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
  } else {
    // A real registration (whether the very first one, or the user
    // flipping the Settings toggle back on after opting out) always wins
    // over a stale opt-out flag.
    await setPushOptedOut(false);
  }

  return 'granted';
}

/** Called when the user turns notifications off in Settings, and on
 * sign-out (a stale token left behind would otherwise keep receiving
 * pushes addressed to whoever's device this is, for the *previous*
 * account). Best-effort: if this device never had a token (permission
 * was never granted), there's nothing to delete and Supabase's delete
 * is a no-op either way.
 *
 * `alsoOptOut` defaults true (the Settings-toggle call site) — marks this
 * as an explicit user choice so `syncPushTokenOnLaunch` won't silently
 * re-register on the next app open. Sign-out passes `false`: that's not
 * an opt-out, just cleanup of a token that would otherwise outlive the
 * session it was registered for — the *next* person to sign into this
 * device should still get the normal launch-time prompt/resync, not
 * inherit a stranger's earlier "no thanks." */
export async function unregisterPushToken(alsoOptOut = true): Promise<void> {
  if (alsoOptOut) {
    await setPushOptedOut(true);
  }

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

/** Called on every app launch/session-restore. Unlike the old "silent
 * resync only" behavior, this now *does* prompt — once, automatically —
 * the same way WhatsApp asks for notification permission as part of
 * initial setup rather than waiting for someone to go dig it out of
 * Settings. Safe to call unconditionally on every launch: `undetermined`
 * only shows the real OS dialog the first time (both iOS and Android
 * cache a real answer after that and just return it silently), `denied`
 * is left alone rather than nagging, and an explicit in-app opt-out
 * (`unregisterPushToken`) is respected so this can never re-enable
 * something the user deliberately turned off. */
export async function syncPushTokenOnLaunch(userId: string): Promise<void> {
  if (!Device.isDevice) return;
  if (await getPushOptedOut()) return;

  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'denied') return;

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

/** The `data` payload every server-side `sendPushToUser` call site
 * attaches (supabase/functions/_shared/push.ts and its callers) — kept in
 * sync by hand on both ends, same as every other Edge-Function request/
 * response shape in this app (no shared-types package between the two
 * runtimes). Every field optional: a notification only ever carries the
 * one or two fields relevant to its own `type`. */
export interface PushNotificationData {
  type?: string;
  thread_id?: string;
  group_thread_id?: string;
}

/** Resolves a tapped notification to the in-app screen WhatsApp's own
 * equivalent notification would open: a message notification (1:1 or
 * group) opens straight into that conversation; every wallet-adjacent
 * notification (a top-up landing, a withdrawal completing, credit someone
 * sent you, the no-bank-account reminder) opens the Wallet tab, which is
 * the one screen that already surfaces all of those. `null` means "just
 * open the app" — the safe default for a `data` shape this client
 * doesn't recognize (e.g. shipped by a newer server build before the
 * client that understands its new `type` value). */
export function resolvePushNotificationRoute(
  data: PushNotificationData | undefined,
): string | null {
  if (!data) return null;
  if (data.thread_id) return `/thread/${data.thread_id}`;
  if (data.group_thread_id) return `/group-thread/${data.group_thread_id}`;

  switch (data.type) {
    case 'topup_confirmed':
    case 'withdrawal_completed':
    case 'credit_transfer_received':
    case 'no_bank_account_reminder':
      return '/wallet';
    default:
      return null;
  }
}
