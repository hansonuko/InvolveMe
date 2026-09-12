import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useSession } from '@/lib/hooks/useSession';
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

  if (isLoading) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
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
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
