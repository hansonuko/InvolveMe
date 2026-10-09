import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { useIsLinkedDevice } from '@/lib/hooks/useIsLinkedDevice';
import { useTheme } from '@/theme';

/**
 * docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 6 — the persistent
 * "Linked to [phone]'s account" chrome WhatsApp Web itself shows, so a
 * companion session never looks indistinguishable from signing in
 * directly. Mounted once in `app/_layout.tsx`, same overlay posture
 * `OfflineBanner` already establishes — unlike that one, this never
 * auto-dismisses; it's load-bearing context for as long as the session
 * is a linked one, not a transient status flash.
 *
 * `session.user.phone` is the real, GoTrue-resolved phone for `sub` (the
 * primary account this companion is linked to) — confirmed elsewhere in
 * this app (`app/(auth)/two-step.tsx`'s own "Not {phone}? Sign out" row)
 * that `setSession()` populates this from the actual user record, not
 * from the signed token's own payload (which never carries a phone claim
 * at all — see `_shared/linkedDeviceToken.ts`).
 */
export function LinkedDeviceBanner() {
  const isLinkedDevice = useIsLinkedDevice();
  const { session } = useSession();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  if (!isLinkedDevice) return null;

  const phone = session?.user.phone ? `+${session.user.phone}` : 'your phone';

  return (
    <View
      pointerEvents="none"
      style={[
        styles.container,
        { top: insets.top, backgroundColor: colors.brandPrimary, paddingVertical: spacing.xs },
      ]}
    >
      <Text variant="caption" color="inverse">
        Linked to {phone}&apos;s account
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 50,
  },
});
