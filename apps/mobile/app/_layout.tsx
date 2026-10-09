import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import * as Notifications from 'expo-notifications';
import { type Href, Stack, useRouter, useSegments, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ChatsScreen } from '@/app/(tabs)/chats';
import { AnimatedSplash } from '@/components/AnimatedSplash';
import { AppLockScreen } from '@/components/AppLockScreen';
import { AppAlertHost } from '@/components/ui/AppAlertHost';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { InstallPwaPrompt } from '@/components/InstallPwaPrompt';
import { LinkedDeviceBanner } from '@/components/LinkedDeviceBanner';
import { OfflineBanner } from '@/components/OfflineBanner';
import { useAppLock } from '@/lib/appLock';
import { registerDeviceFingerprint } from '@/lib/deviceFingerprint';
import { useSession } from '@/lib/hooks/useSession';
import { useIsWideWeb } from '@/lib/hooks/useIsWideWeb';
import { useLastSeenHeartbeat } from '@/lib/lastSeen';
import { useOnboardingStatusStore } from '@/lib/onboardingStore';
import { useOutboxDrain } from '@/lib/outboxDrain';
import { checkForOtaUpdateOnLaunch } from '@/lib/otaUpdates';
import {
  type PushNotificationData,
  resolvePushNotificationRoute,
  syncPushTokenOnLaunch,
} from '@/lib/push';
import { useTwoStepGateStore } from '@/lib/twoStepGateStore';
import { ThemeProvider, useTheme } from '@/theme';

/** Themed wrapper for the sidebar's own border — a plain function
 * component (not inlined in RootLayout's own body) specifically because
 * `useTheme()` needs a `ThemeProvider` ancestor, which `RootLayout` itself
 * renders rather than sits inside; this is rendered as a *child* of that
 * provider instead, same as every other themed component in this tree. */
function ChatsSidebar() {
  const { colors } = useTheme();
  return (
    <View style={[styles.sidebar, { borderRightColor: colors.borderSubtle }]}>
      <ChatsScreen />
    </View>
  );
}

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

// Offline mode (docs/13-OFFLINE-MODE-SCOPING.md) — persists the query cache
// to the AsyncStorage already used elsewhere in this app, so every
// already-fetched screen (chats, threads, groups, statuses, wallet
// balance) renders its last-known data immediately on a cold start with no
// connectivity, instead of an empty/loading screen. `buster` must be bumped
// whenever a cached query's shape changes in a way an old persisted payload
// couldn't satisfy, so a stale shape is discarded rather than fed to a
// component expecting the new one.
const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: 'involveme-query-cache-v1',
});
const persistOptions = {
  persister: asyncStoragePersister,
  maxAge: 24 * 60 * 60 * 1000,
  buster: 'v1',
};

/** Mounted once, inside the query client's own provider tree, so
 * `useQueryClient()` resolves — see lib/outboxDrain.ts's header comment for
 * why this lives globally rather than per-thread-screen. */
function OutboxDrainEffect({ userId }: { userId: string | undefined }) {
  useOutboxDrain(userId);
  return null;
}

/**
 * Auth gate: redirects between the (auth) and (tabs) route groups based on
 * session state. Manual segment check rather than a routing library feature,
 * kept simple on purpose for Phase 0 — revisit if expo-router's protected-route
 * API covers this more cleanly by the time Phase 2 chat screens land.
 *
 * `needsOnboarding` (docs/10-UX-REFINEMENT-BACKLOG.md Batch E, E2) and
 * `twoStepPinVerified` (punch-list item 2) are both `null` while
 * unchecked — same "don't redirect on unknown state" posture as
 * `isLoading` — so a fresh session doesn't flash into /chats before
 * either resolves. `null` is treated as "nothing to gate on" for the
 * purposes of *leaving* /(auth)/onboarding or /(auth)/two-step, never for
 * *entering* either — see the branches below. Two-step is checked only
 * once onboarding is confirmed done: it's a post-onboarding Settings
 * feature, so a brand-new account can never have it on yet, and checking
 * it in onboarding's own still-`null` window would be meaningless anyway.
 */
function useAuthGate(
  isLoading: boolean,
  hasSession: boolean,
  needsOnboarding: boolean | null,
  twoStepPinVerified: boolean | null,
) {
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    // Cast away expo-router's fixed-length typed-route tuple — this is a
    // plain runtime segments array, and its length varies by exactly the
    // amount this check needs to inspect (index 1 only exists once inside
    // a group).
    const segmentList = segments as string[];
    const inAuthGroup = segmentList[0] === '(auth)';
    const inOnboarding = inAuthGroup && segmentList[1] === 'onboarding';
    const inTwoStep = inAuthGroup && segmentList[1] === 'two-step';

    if (!hasSession) {
      if (!inAuthGroup) router.replace('/(auth)');
      return;
    }

    // hasSession is true below this point. Wait for the onboarding check
    // to resolve before deciding between /onboarding and everything else
    // — `null` is deliberately not treated as "false" here (unlike a
    // plain `!` check), or a fresh session would flash straight into
    // /chats for the one tick before the real answer comes back.
    if (needsOnboarding === null) return;

    if (needsOnboarding && !inOnboarding) {
      router.replace('/(auth)/onboarding');
      return;
    }
    if (needsOnboarding) return; // in onboarding, correctly — nothing else to do yet

    // Onboarding is done. Same "wait for null to resolve" treatment for
    // the two-step gate.
    if (twoStepPinVerified === null) return;

    if (!twoStepPinVerified && !inTwoStep) {
      router.replace('/(auth)/two-step');
    } else if (twoStepPinVerified && inAuthGroup) {
      router.replace('/(tabs)/chats');
    }
  }, [isLoading, hasSession, needsOnboarding, twoStepPinVerified, segments, router]);
}

export default function RootLayout() {
  const { session, isLoading } = useSession();
  const needsOnboarding = useOnboardingStatusStore((s) => s.needsOnboarding);
  const checkOnboardingStatus = useOnboardingStatusStore((s) => s.checkOnboardingStatus);
  const resetOnboardingStatus = useOnboardingStatusStore((s) => s.reset);
  const twoStepPinVerified = useTwoStepGateStore((s) => s.pinVerified);
  const checkTwoStepPinStatus = useTwoStepGateStore((s) => s.checkPinStatus);
  const resetTwoStepGate = useTwoStepGateStore((s) => s.reset);
  useAuthGate(isLoading, !!session, needsOnboarding, twoStepPinVerified);
  useLastSeenHeartbeat(session?.user.id);
  const { locked, retry } = useAppLock(!!session);

  // docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 7 — the two-pane chat
  // layout's persistent sidebar. Mounted here (root level), not inside
  // app/(tabs)/_layout.tsx, because /thread/[id] is itself a root-level
  // Stack sibling of (tabs), not nested under it (see that screen's own
  // Stack.Screen comment below) — a sidebar living inside (tabs) could
  // never appear next to an open thread at all. Scoped to exactly the
  // chats-list and thread routes (not /groups, /wallet, /status,
  // /settings, …) — those have no natural list+detail relationship with a
  // sidebar the way chats does, and keeping it scoped means every other
  // route's layout is completely untouched by this milestone.
  const isWideWeb = useIsWideWeb();
  const pathname = usePathname();
  const showChatsSidebar =
    isWideWeb && !!session && (pathname === '/chats' || pathname.startsWith('/thread/'));

  // AnimatedSplash now owns hiding the native splash (see its own header
  // comment) — it calls SplashScreen.hideAsync() itself the instant it
  // mounts, so the hand-off from native-static to JS-animated is seamless
  // instead of a hide-then-blank-then-render gap.
  const [splashDone, setSplashDone] = useState(false);

  // Runs once per cold start, unconditional on session state — see
  // lib/otaUpdates.ts's header comment for why this exists (this app's
  // default expo-updates check policy silently defers a downloaded
  // update to the *next* restart, not this one). Deliberately not
  // awaited or blocking splash-hide above: if it has something newer, it
  // reloads the whole JS context transparently once ready, same as
  // ErrorBoundary's own reload path.
  useEffect(() => {
    void checkForOtaUpdateOnLaunch();
  }, []);

  // Resolves whether this session's user still needs (auth)/onboarding
  // (docs/10-UX-REFINEMENT-BACKLOG.md Batch E, E2) — reset on sign-out so a
  // different user signing in on the same device gets a fresh check rather
  // than reusing the previous user's cached answer.
  useEffect(() => {
    if (session?.user.id) {
      void checkOnboardingStatus(session.user.id);
    } else {
      resetOnboardingStatus();
    }
  }, [session?.user.id, checkOnboardingStatus, resetOnboardingStatus]);

  // Resolves whether this session still needs to clear the two-step-
  // verification PIN gate (punch-list item 2) — reset on sign-out for the
  // same "don't reuse a different user's cached answer" reason
  // checkOnboardingStatus's own effect already documents.
  useEffect(() => {
    if (session?.user.id) {
      void checkTwoStepPinStatus(session.user.id);
    } else {
      resetTwoStepGate();
    }
  }, [session?.user.id, checkTwoStepPinStatus, resetTwoStepGate]);

  // Runs on every launch/session-restore — prompts for notification
  // permission automatically the first time (WhatsApp's own behavior,
  // not "buried in Settings until someone finds it"), silently re-syncs
  // an already-granted token otherwise, and never touches anything if
  // this device explicitly opted out. See lib/push.ts's own header
  // comment on syncPushTokenOnLaunch for the full reasoning.
  useEffect(() => {
    if (session?.user.id) {
      void syncPushTokenOnLaunch(session.user.id);
    }
  }, [session?.user.id]);

  // Tapping a push notification should open the conversation/screen it's
  // about, the same way WhatsApp's own notifications do — not just bring
  // the app to the foreground with no idea what was tapped. Two cases:
  // the listener below fires while JS is already running (foreground or
  // backgrounded-but-alive); getLastNotificationResponseAsync covers a
  // cold start where the tap is what launched the process in the first
  // place, which the listener alone would never see.
  const router = useRouter();
  useEffect(() => {
    const handleResponse = (response: Notifications.NotificationResponse) => {
      const route = resolvePushNotificationRoute(
        response.notification.request.content.data as PushNotificationData,
      );
      if (route) router.push(route as Href);
    };

    // Both calls below are real native modules with no web implementation
    // — expo-notifications throws an UnavailabilityError SYNCHRONOUSLY
    // rather than rejecting a promise (confirmed live: an unguarded call
    // here crashed the whole app on `expo start --web`, an unhandled
    // throw inside a passive effect). Same "never let an automatic,
    // silent-startup native call go unguarded" posture registerPushToken's
    // own header comment already documents, applied here too.
    let subscription: { remove: () => void } | undefined;
    try {
      subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
    } catch (e) {
      console.error('notification response listener unavailable:', e);
    }

    try {
      // Cold start: the app was launched BY tapping a notification — the
      // listener above only fires for taps while JS is already running.
      void Notifications.getLastNotificationResponseAsync()
        .then((response) => {
          if (response) handleResponse(response);
        })
        .catch((e) => console.error('getLastNotificationResponseAsync failed:', e));
    } catch (e) {
      console.error('getLastNotificationResponseAsync unavailable:', e);
    }

    return () => subscription?.remove();
  }, [router]);

  // Fraud-infra device link (docs/06-SECURITY-FRAUD-LOOPHOLES.md §2) — no
  // permission prompt, no user-visible effect either way. Same automatic,
  // silent-startup shape as the push resync above, and guarded the same
  // deliberate way internally (see lib/deviceFingerprint.ts).
  useEffect(() => {
    if (session?.user.id) {
      void registerDeviceFingerprint();
    }
  }, [session?.user.id]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        {/* Catches any uncaught render-time crash anywhere below this
            point — see components/ErrorBoundary.tsx's header comment for
            why this exists (a real "blank unresponsive screen" bug report
            with no crash reporting anywhere to diagnose it from). Inside
            ThemeProvider so its own fallback UI can use theme/UI
            primitives; wraps QueryClientProvider too so a crash doesn't
            leave a half-torn-down query cache behind. */}
        <ErrorBoundary>
          <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
            <OutboxDrainEffect userId={session?.user.id} />
            <OfflineBanner />
            <LinkedDeviceBanner />
            <InstallPwaPrompt />
            {/* Themed Alert.alert replacement (lib/ui/alert.ts) — mounted
                once here, same level as AppLockScreen below, so it can
                overlay any screen regardless of which one triggered it. */}
            <AppAlertHost />
            {/* The navigator stays mounted at all times — it used to be
                swapped out for <AppLockScreen> entirely whenever `locked`
                was true, which meant every re-lock (including the
                false-positive ones a system camera/permission/share-sheet
                dialog used to cause — see lib/appLock.ts's header comment)
                unmounted the whole route tree. expo-router then had to
                re-resolve an initial route from scratch on remount, which
                is what produced the phone-entry-screen flash and the
                "app is reloading itself" reports (docs/00-SESSION-HANDOFF.md's
                2026-09-17 punch list items 2/8/9). Locking now overlays
                <AppLockScreen> on top instead, the same way a lock screen
                covers, rather than kills, whatever's running underneath it
                on other platforms. */}
            <View style={showChatsSidebar ? styles.twoPaneRow : styles.flex}>
              {/* The persistent two-pane sidebar (docs/12 Milestone 7) —
                  the exact same ChatsScreen component app/(tabs)/chats.tsx
                  itself renders on native/narrow web, mounted once here so
                  it never remounts (and never loses scroll position/
                  refetches its thread list) while navigating between
                  /chats and /thread/[id] underneath it. Rendered OUTSIDE
                  the Stack entirely — it isn't a route, just a sidebar
                  that happens to sit next to whatever the Stack is
                  currently showing. */}
              {showChatsSidebar ? <ChatsSidebar /> : null}
              <View style={styles.flex}>
                {/* Only the two route groups are registered here — thread/[id] and
                    settings/index set their own header options inline via
                    <Stack.Screen options={...} /> from within the screen itself,
                    which avoids relying on exact nested-route name matching. */}
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="(auth)" />
                  <Stack.Screen name="(tabs)" />
                </Stack>
              </View>
              {locked ? (
                // Never reached while `!session`, since useAppLock reports
                // `unlocked` with nothing to protect yet. Opaque and
                // full-screen, so it both visually covers and (being on
                // top of the view stack) intercepts touches to the
                // navigator underneath.
                <View style={StyleSheet.absoluteFill}>
                  <AppLockScreen onRetry={retry} />
                </View>
              ) : null}
              {/* Covers the Stack above (and the brief window where it may
                  mount with the wrong initial route before useAuthGate's
                  redirect effect fires — the same flash the old `if
                  (isLoading) return null` guard existed to prevent) until
                  session/onboarding/two-step state is fully resolved, then
                  fades out. Stays mounted across the isLoading -> ready
                  transition rather than swapping components, so its
                  entrance animation never restarts mid-transition. */}
              {!splashDone ? (
                <AnimatedSplash ready={!isLoading} onFinished={() => setSplashDone(true)} />
              ) : null}
            </View>
          </PersistQueryClientProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  twoPaneRow: { flex: 1, flexDirection: 'row' },
  // A fixed width, not a flex fraction — WhatsApp Web's own sidebar is a
  // fixed ~30% that doesn't keep growing on very wide monitors, and a
  // fixed px value is simpler to reason about than a percentage that'd
  // need its own min/max clamping to stay usable at any width above the
  // 900px breakpoint this layout only activates past anyway.
  sidebar: { width: 360, borderRightWidth: 1 },
});
