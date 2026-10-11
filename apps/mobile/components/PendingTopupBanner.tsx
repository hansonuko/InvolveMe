import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { usePendingTopupStore } from '@/lib/pendingTopupStore';
import { useTopupStatus } from '@/lib/queries/wallet';
import { useTheme } from '@/theme';

const RESULT_DISMISS_MS = 3000;

/**
 * Durable counterpart to `BuyCreditModal`'s own in-progress top-up UI —
 * mounted once in `app/_layout.tsx`, same overlay posture `OfflineBanner`
 * already establishes, specifically so a top-up started before a reload
 * (see `lib/pendingTopupStore.ts`'s header comment) still gets tracked and
 * reported no matter which screen the user lands back on, not only if
 * they happen to reopen the wallet tab's own modal. Reuses
 * `useTopupStatus` (`lib/queries/wallet.ts`) unchanged — that hook already
 * does the real-time subscription + active poll this needs, there's
 * nothing new to build here.
 *
 * No separate "dismissed" flag needed: once a terminal status has shown
 * for `RESULT_DISMISS_MS`, this clears the store's own `pendingTopupId`
 * directly, which is the exact same thing that makes this component
 * render nothing — one piece of state, not two kept in sync.
 */
export function PendingTopupBanner() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const pendingTopupId = usePendingTopupStore((s) => s.pendingTopupId);
  const amountKobo = usePendingTopupStore((s) => s.amountKobo);
  const clearPendingTopup = usePendingTopupStore((s) => s.clearPendingTopup);
  const { data: status } = useTopupStatus(pendingTopupId ?? undefined);

  useEffect(() => {
    if (!status || status === 'pending') return;
    const t = setTimeout(() => clearPendingTopup(), RESULT_DISMISS_MS);
    return () => clearTimeout(t);
  }, [status, clearPendingTopup]);

  if (!pendingTopupId) return null;

  const naira = amountKobo ? `₦${(amountKobo / 100).toLocaleString()}` : 'your';
  const isFailure = status === 'failed' || status === 'reversed';

  return (
    <View
      pointerEvents="none"
      style={[
        styles.container,
        {
          top: insets.top,
          backgroundColor: isFailure ? colors.danger : colors.success,
          paddingVertical: spacing.xs,
        },
      ]}
    >
      <Text variant="caption" style={{ color: colors.bgCanvas }}>
        {status === 'completed'
          ? `🎉 ${naira} credit added!`
          : isFailure
            ? `${naira} top-up didn't go through. Check your wallet.`
            : `Confirming your ${naira} top-up…`}
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
