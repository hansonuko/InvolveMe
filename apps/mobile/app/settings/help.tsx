import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Share, View } from 'react-native';

import { getLastCrash } from '@/components/ErrorBoundary';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { withAppLockSuppressed } from '@/lib/appLock';
import { shareInvite } from '@/lib/invite';
import { useTheme } from '@/theme';

/** Shares the raw crash record via the OS share sheet — same "report a
 * problem" shape as `shareInvite`, and needs the same app-lock bracket
 * since the share sheet backgrounds this app the same way. There's no
 * support inbox to send this to directly, so sharing (e.g. to an email
 * app) is the whole mechanism, matching `getLastCrash`'s own doc comment
 * ("a future 'send crash report' support flow"). */
function reportCrash(crash: { message: string; stack?: string; timestamp: string }) {
  const lines = [
    `InvolveMe crash report — ${crash.timestamp}`,
    crash.message,
    crash.stack ?? '',
  ].filter(Boolean);
  return withAppLockSuppressed(() => Share.share({ message: lines.join('\n\n') }));
}

function Row({ label, onPress, value }: { label: string; onPress?: () => void; value?: string }) {
  const { colors, spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: spacing.md,
          backgroundColor: pressed && onPress ? colors.bgSurfaceAlt : 'transparent',
        },
      ]}
    >
      <Text variant="body">{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {value ? (
          <Text variant="body" color="tertiary">
            {value}
          </Text>
        ) : null}
        {onPress ? <Text color="tertiary">›</Text> : null}
      </View>
    </Pressable>
  );
}

export default function HelpSettingsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [lastCrash, setLastCrash] = useState<Awaited<ReturnType<typeof getLastCrash>>>(null);

  useEffect(() => {
    getLastCrash().then(setLastCrash);
  }, []);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Help',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen>
        <Row label="Invite a friend" onPress={() => void shareInvite()} />
        <Row label="Terms of Service" onPress={() => router.push('/legal/terms')} />
        <Row label="Privacy Policy" onPress={() => router.push('/legal/privacy')} />
        {lastCrash ? (
          <Row
            label="Report a problem"
            value={new Date(lastCrash.timestamp).toLocaleString()}
            onPress={() => void reportCrash(lastCrash)}
          />
        ) : null}
        <Row label="App version" value={Constants.expoConfig?.version ?? '—'} />
      </Screen>
    </>
  );
}
