import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { ErrorBoundary } from '@/components/ErrorBoundary';
import { registerDeviceFingerprint } from '@/lib/deviceFingerprint';
import { useSession } from '@/lib/hooks/useSession';
import { resyncPushTokenIfPermitted } from '@/lib/push';
import { ThemeProvider } from '@/theme';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

/**
 * Auth gate: redirects between the (auth) and (tabs) route groups based on
 * session state. Manual segment check rather than a routing library feature,
 * kept simple on purpose for Phase 0 — revisit if expo-router's protected-route
 * API covers this more cleanly by the time Phase 2 chat screens land.
 */
function useAuthGate(isLoading: boolean, hasSession: boolean) {
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!hasSession && !inAuthGroup) {
      router.replace('/(auth)');
    } else if (hasSession && inAuthGroup) {
      router.replace('/(tabs)/chats');
    }
  }, [isLoading, hasSession, segments, router]);
}

export default function RootLayout() {
  const { session, isLoading } = useSession();
  useAuthGate(isLoading, !!session);

  useEffect(() => {
    if (!isLoading) {
      SplashScreen.hideAsync();
    }
  }, [isLoading]);

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
            {/* Only the two route groups are registered here — thread/[id] and
                settings/index set their own header options inline via
                <Stack.Screen options={...} /> from within the screen itself,
                which avoids relying on exact nested-route name matching. */}
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(auth)" />
              <Stack.Screen name="(tabs)" />
            </Stack>
          </QueryClientProvider>
        </ErrorBoundary>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
