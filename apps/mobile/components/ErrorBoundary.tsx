import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { Component, type ErrorInfo, type PropsWithChildren } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useTheme } from '@/theme';

/**
 * Root-level error boundary — added 2026-09-14 (session 12, continued)
 * chasing a real user report: an intermittent full-black, unresponsive
 * screen that only recovers with a force-close/swipe-kill. This app had
 * zero error boundaries anywhere (grepped the whole tree to confirm, not
 * assumed) — an uncaught render-time exception ANYWHERE, from any cause,
 * has always produced exactly that symptom: React's own error propagation
 * unmounts the tree with nothing left to render and no fallback UI to
 * show, and in a release build there's no red box either, just silence.
 *
 * This doesn't identify the specific root cause (still unconfirmed without
 * a precise repro from the user) — it's the structural fix that makes
 * *any* such crash recoverable instead of catastrophic, and the piece
 * this app has been missing since session 11's own "no crash reporting
 * wired up yet" flag. See lib/push.ts's registerPushToken for the
 * strongest concrete lead found by code review this session (the one
 * `getExpoPushTokenAsync` call site in that file left unguarded, unlike
 * its two siblings, on the exact automatic/silent path that runs on every
 * app session restore) — fixed there too, but this boundary is what
 * catches it (or anything else) if that wasn't the whole story.
 *
 * Persists a lightweight crash record to AsyncStorage (message, stack,
 * timestamp — same storage this app already uses for the Supabase
 * session, no new dependency) so a *future* crash leaves an actual trace
 * instead of only a secondhand description of symptoms. `Updates.reloadAsync()`
 * (expo-updates, already installed for OTA) gives a real full-JS-context
 * reload — resetting this component's own state wouldn't help if the
 * crash came from corrupted app-wide state, which a render-time throw
 * gives no way to rule out.
 */

const LAST_CRASH_STORAGE_KEY = 'involveme:last-crash';

interface StoredCrash {
  message: string;
  stack?: string;
  componentStack?: string;
  timestamp: string;
}

/** Read on demand — `settings/help.tsx`'s "Report a problem" row reads
 * this to decide whether to show itself, and shares the record out via
 * the OS share sheet when tapped (no support inbox exists to send it to
 * directly). */
export async function getLastCrash(): Promise<StoredCrash | null> {
  const raw = await AsyncStorage.getItem(LAST_CRASH_STORAGE_KEY);
  return raw ? (JSON.parse(raw) as StoredCrash) : null;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<PropsWithChildren, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught a render-time crash:', error, info.componentStack);
    const record: StoredCrash = {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
      timestamp: new Date().toISOString(),
    };
    // Best-effort — a storage failure here must not itself throw inside
    // componentDidCatch, which would leave the boundary's own fallback
    // unable to render.
    AsyncStorage.setItem(LAST_CRASH_STORAGE_KEY, JSON.stringify(record)).catch(() => {});
  }

  render() {
    if (this.state.error) {
      return <CrashFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}

function CrashFallback({ error }: { error: Error }) {
  const { spacing } = useTheme();
  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: spacing.md }}>
        <Text variant="title" style={{ textAlign: 'center' }}>
          Something went wrong
        </Text>
        <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
          InvolveMe hit an unexpected error and needs to reload. Nothing you were doing caused this
          — it&apos;s been logged so it can be fixed.
        </Text>
        <Button
          label="Reload"
          onPress={() => {
            // A full reload of the JS context, not just resetting this
            // component's state — the crash could have come from state
            // corruption anywhere in the tree above this boundary.
            // reloadAsync itself can reject (e.g. expo-updates isn't
            // fully initialized in some dev contexts) — this screen's
            // entire job is to be the last line of defense, so its own
            // recovery action failing silently is acceptable, throwing
            // further is not.
            Updates.reloadAsync().catch((e) => console.error('ErrorBoundary reload failed:', e));
          }}
          style={{ marginTop: spacing.lg }}
        />
        {__DEV__ ? (
          <Text variant="caption" color="secondary" style={{ marginTop: spacing.xl }}>
            {error.message}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}
