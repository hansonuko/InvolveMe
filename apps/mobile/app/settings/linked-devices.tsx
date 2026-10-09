import { Ionicons } from '@expo/vector-icons';
import { Stack } from 'expo-router';
import { Pressable, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { EdgeFunctionError } from '@/lib/edgeFunctions';
import {
  type LinkedDevice,
  useLinkedDevices,
  useRevokeLinkedDevice,
} from '@/lib/queries/linkedDevices';
import { showAlert } from '@/lib/ui/alert';
import { useTheme } from '@/theme';

function platformIcon(platform: string | null): keyof typeof Ionicons.glyphMap {
  if (platform === 'web') return 'desktop-outline';
  if (platform === 'ios' || platform === 'android') return 'phone-portrait-outline';
  return 'hardware-chip-outline';
}

function DeviceRow({ device }: { device: LinkedDevice }) {
  const { colors, spacing, radius } = useTheme();
  const revoke = useRevokeLinkedDevice();

  const handleRevoke = () => {
    showAlert('Log out this device?', `"${device.label}" will lose access immediately.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log out',
        style: 'destructive',
        onPress: () => {
          revoke.mutate(device.id, {
            onError: (e) => {
              const message =
                e instanceof EdgeFunctionError ? e.message : 'Could not log out that device.';
              showAlert('Something went wrong', message);
            },
          });
        },
      },
    ]);
  };

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.md,
      }}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.bgSurfaceAlt,
        }}
      >
        <Ionicons name={platformIcon(device.platform)} size={18} color={colors.textSecondary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="body">{device.label}</Text>
        <Text variant="caption" color="tertiary">
          Active {new Date(device.last_active_at).toLocaleDateString()}
        </Text>
      </View>
      <Pressable
        onPress={handleRevoke}
        disabled={revoke.isPending}
        hitSlop={8}
        style={{
          paddingVertical: spacing.xs,
          paddingHorizontal: spacing.sm,
          borderRadius: radius.pill,
        }}
      >
        <Text variant="caption" color="danger">
          Log out
        </Text>
      </Pressable>
    </View>
  );
}

/** docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 5 — lists this user's
 * companion (web) sessions with per-device and bulk revoke, the mobile
 * counterpart to WhatsApp's own "Linked Devices" settings screen. Primary
 * phone sessions never appear here — only rows `confirm-device-pairing`
 * created. */
export default function LinkedDevicesScreen() {
  const { colors, spacing } = useTheme();
  const { data: devices, isLoading } = useLinkedDevices();
  const revokeAll = useRevokeLinkedDevice();

  const handleLogOutAll = () => {
    showAlert(
      'Log out of all linked devices?',
      'Every browser linked to your account will lose access immediately.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log out all',
          style: 'destructive',
          onPress: () => {
            revokeAll.mutate(undefined, {
              onError: (e) => {
                const message =
                  e instanceof EdgeFunctionError ? e.message : 'Could not log out those devices.';
                showAlert('Something went wrong', message);
              },
            });
          },
        },
      ],
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Linked Devices',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen edges={['right', 'bottom', 'left']}>
        <Text variant="caption" color="tertiary" style={{ marginBottom: spacing.md }}>
          Devices linked via Link a device → scan QR code. Each one can use InvolveMe from a
          browser, signed in as you.
        </Text>

        {isLoading ? null : !devices || devices.length === 0 ? (
          <Text variant="body" color="tertiary">
            No linked devices yet.
          </Text>
        ) : (
          <View>
            {devices.map((device) => (
              <DeviceRow key={device.id} device={device} />
            ))}
          </View>
        )}

        {devices && devices.length > 0 ? (
          <Button
            label="Log out of all linked devices"
            variant="secondary"
            onPress={handleLogOutAll}
            disabled={revokeAll.isPending}
            style={{ marginTop: spacing.xl }}
          />
        ) : null}
      </Screen>
    </>
  );
}
