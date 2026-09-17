import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useTheme } from '@/theme';

/** Full-screen gate shown while `useAppLock` (lib/appLock.ts) reports
 * `locked` — covers the whole app rather than a per-screen check, since
 * the point is nothing behind it should be visible or interactive until
 * the device's own biometric/passcode check passes. */
export function AppLockScreen({ onRetry }: { onRetry: () => void }) {
  const { colors, spacing } = useTheme();

  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.lg }}>
        <Ionicons name="lock-closed" size={48} color={colors.textSecondary} />
        <Text variant="title">InvolveMe is locked</Text>
        <Text variant="body" color="tertiary" style={{ textAlign: 'center' }}>
          Unlock with your device&apos;s biometrics or passcode to continue.
        </Text>
        <Button label="Unlock" onPress={onRetry} />
      </View>
    </Screen>
  );
}
