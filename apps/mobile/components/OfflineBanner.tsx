import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useIsOnline } from '@/lib/network';
import { useTheme } from '@/theme';

/** Thin, dismissable status strip over the top of the navigator — mounted
 * once in app/_layout.tsx, same overlay posture AppLockScreen already
 * establishes for a full-screen gate. "No internet connection" persists
 * for as long as `useIsOnline()` reports false; "Back online" flashes
 * briefly on the transition back before disappearing entirely, matching
 * WhatsApp's own "Connecting..." → nothing pattern rather than a modal or
 * a permanent chrome element. */
export function OfflineBanner() {
  const isOnline = useIsOnline();
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const [showReconnected, setShowReconnected] = useState(false);
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true;
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    setShowReconnected(true);
    const t = setTimeout(() => setShowReconnected(false), 1800);
    return () => clearTimeout(t);
  }, [isOnline]);

  if (isOnline && !showReconnected) return null;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.container,
        {
          top: insets.top,
          backgroundColor: isOnline ? colors.success : colors.warning,
          paddingVertical: spacing.xs,
        },
      ]}
    >
      <Text variant="caption" style={{ color: colors.bgCanvas }}>
        {isOnline ? 'Back online' : 'No internet connection'}
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
