import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { shareInvite } from '@/lib/invite';
import { useTheme } from '@/theme';

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
        <Row label="App version" value={Constants.expoConfig?.version ?? '—'} />
      </Screen>
    </>
  );
}
