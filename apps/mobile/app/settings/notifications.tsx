import { Stack } from 'expo-router';
import { Pressable, Switch, View } from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { useSetPushEnabled, usePushEnabled } from '@/lib/queries/notifications';
import { showAlert } from '@/lib/ui/alert';
import { useTheme } from '@/theme';

export default function NotificationsSettingsScreen() {
  const { colors, spacing } = useTheme();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: pushEnabled, isLoading: pushLoading } = usePushEnabled(userId);
  const setPushEnabled = useSetPushEnabled();

  const handleTogglePush = async (enabled: boolean) => {
    if (!userId) return;
    const result = await setPushEnabled.mutateAsync({ userId, enabled });
    if (enabled && result === 'denied') {
      showAlert(
        'Notifications off',
        "Notification permission was denied. Turn it on in your phone's Settings app to receive them.",
      );
    } else if (enabled && result === 'unsupported') {
      showAlert('Not available', 'Push notifications need a real device, not a simulator.');
    } else if (enabled && result === 'error') {
      showAlert(
        "Couldn't turn on notifications",
        'Something went wrong reaching the notification service — check your connection and try again.',
      );
    }
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Notifications',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen edges={['right', 'bottom', 'left']}>
        <Pressable
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingVertical: spacing.md,
          }}
        >
          <Text variant="body">Push notifications</Text>
          <Switch
            value={!!pushEnabled}
            disabled={pushLoading || setPushEnabled.isPending}
            onValueChange={handleTogglePush}
          />
        </Pressable>
        <View style={{ paddingTop: spacing.sm }}>
          <Text variant="caption" color="tertiary">
            New messages, top-ups, withdrawals, and credit you receive.
          </Text>
        </View>
      </Screen>
    </>
  );
}
