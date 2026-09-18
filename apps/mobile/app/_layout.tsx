import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AppLockScreen } from '@/components/AppLockScreen';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useAppLock } from '@/lib/appLock';
import { registerDeviceFingerprint } from '@/lib/deviceFingerprint';
import { useSession } from '@/lib/hooks/useSession';
import { useLastSeenHeartbeat } from '@/lib/lastSeen';
import { useOnboardingStatusStore } from '@/lib/onboardingStore';
import { resyncPushTokenIfPermitted } from '@/lib/push';
import { ThemeProvider } from '@/theme';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

/**
 * Auth gate: redirects between the (auth) and (tabs) route groups based on
 * session state. Manual segment check rather than a routing library feature,
 * kept simple on purpose for Phase 0 — revisit if expo-router's protected-route
 * API covers this more cleanly by the time Phase 2 chat screens land.
 *
 * `needsOnboarding` (docs/10-UX-REFINEMENT-BACKLOG.md Batch E, E2) is
 * `null` while unchecked — same "don't redirect on unknown state" posture
 * as `isLoading` — so a fresh session doesn't flash into /chats before
 * onboarding status resolves. `null` is treated as "not onboarding" for
 * the purposes of leaving /(auth)/onboarding, not entering it — see the
 * two branches below.
 */
function useAuthGate(isLoading: boolean, hasSession: boolean, needsOnboarding: boolean | null) {
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

    if (!hasSession) {
      if (!inAuthGroup) router.replace('/(auth)');
      return;
    }

    // hasSession is true below this point. Wait for the onboarding check
    // to resolve before deciding between /onboarding and /chats — `null`
    // is deliberately not treated as "false" here (unlike a plain `!`
    // check), or a fresh session would flash straight into /chats for the
    // one tick before the real answer comes back.
    if (needsOnboarding === null) return;

    if (needsOnboarding && !inOnboarding) {
      router.replace('/(auth)/onboarding');
    } else if (!needsOnboarding && inAuthGroup) {
      router.replace('/(tabs)/chats');
    }
  }, [isLoading, hasSession, needsOnboarding, segments, router]);
}

export default function RootLayout() {
  const { session, isLoading } = useSession();
  const needsOnboarding = useOnboardingStatusStore((s) => s.needsOnboarding);
  const checkOnboardingStatus = useOnboardingStatusStore((s) => s.checkOnboardingStatus);
  const resetOnboardingStatus = useOnboardingStatusStore((s) => s.reset);
  useAuthGate(isLoading, !!session, needsOnboarding);
  useLastSeenHeartbeat(session?.user.id);
  const { locked, retry } = useAppLock(!!session);

  useEffect(() => {
    if (!isLoading) {
      SplashScreen.hideAsync();
    }
  }, [isLoading]);

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

  // Silent re-sync only (never prompts) — see lib/push.ts's header
  // comment. The only place that ever requests notification permission
  // is the explicit toggle in settings/index.tsx.
  useEffect(() => {
    if (session?.user.id) {
      void resyncPushTokenIfPermitted(session.user.id);
    }
  }, [session?.user.id]);

  // Fraud-infra device link (docs/06-SECURITY-FRAUD-LOOPHOLES.md §2) — no
  // permission prompt, no user-visible effect either way. Same automatic,
  // silent-startup shape as the push resync above, and guarded the same
  // deliberate way internally (see lib/deviceFingerprint.ts).
  useEffect(() => {
    if (session?.user.id) {
      void registerDeviceFingerprint();
    }
  }, [session?.user.id]);

  if (isLoading) {
    return null;
  }

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
          <QueryClientProvider client={queryClient}>
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
            <View style={styles.flex}>
              {/* Only the two route groups are registered here — thread/[id] and
                  settings/index set their own header options inline via
                  <Stack.Screen options={...} /> from within the screen itself,
                  which avoids relying on exact nested-route name matching. */}
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(auth)" />
                <Stack.Screen name="(tabs)" />
              </Stack>
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
            </View>
          </QueryClientProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
