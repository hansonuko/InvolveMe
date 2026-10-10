import { useEffect, useState } from 'react';
import { Linking, Modal, Pressable, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Text } from '@/components/ui/Text';
import { MARKETING_URL } from '@/lib/marketingUrl';
import { LAUNCH_DATE, LAUNCH_DATE_LABEL } from '@/lib/prelaunch';
import { useTheme } from '@/theme';

function getTimeRemaining() {
  const diff = LAUNCH_DATE.getTime() - Date.now();
  if (diff <= 0) return null;
  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
  };
}

/**
 * The web-only equivalent of apps/marketing's PrelaunchPopup — shown on
 * every visit to the auth entry screen on `app.involvemechat.com` and
 * `web.involvemechat.com` (mounted from app/(auth)/index.tsx, gated to
 * `Platform.OS === 'web'` there so native is completely unaffected). Opens
 * a beat after mount (not instantly on paint) so it reads as an
 * announcement arriving, same reasoning WebDevicePairingScreen's own
 * hero/card stagger already uses, which this reuses the exact animation
 * shape of (Reanimated spring scale-in, useReducedMotion-aware).
 *
 * Links out to the marketing site rather than navigating in-app —
 * `Linking.openURL`, not `router.push` — because this screen is
 * unauthenticated (docs/12's own [[web-pairing-screen-auth-gate-link-bug]]
 * gotcha: any in-app route pushed from here while logged out just bounces
 * back to the auth gate).
 */
export function PrelaunchAnnouncementModal() {
  const { colors, spacing, radius } = useTheme();
  const [visible, setVisible] = useState(true);
  const [remaining, setRemaining] = useState(getTimeRemaining());

  const reducedMotion = useReducedMotion();
  const cardOpacity = useSharedValue(reducedMotion ? 1 : 0);
  const cardScale = useSharedValue(reducedMotion ? 1 : 0.85);
  const badgeOpacity = useSharedValue(reducedMotion ? 1 : 0);
  const badgeScale = useSharedValue(reducedMotion ? 1 : 0.5);
  const badgePulse = useSharedValue(0);

  useEffect(() => {
    if (!reducedMotion) {
      cardOpacity.value = withDelay(300, withTiming(1, { duration: 450 }));
      cardScale.value = withDelay(
        300,
        withTiming(1, { duration: 450, easing: Easing.out(Easing.back(1.4)) }),
      );
      badgeOpacity.value = withDelay(450, withTiming(1, { duration: 350 }));
      badgeScale.value = withDelay(
        450,
        withTiming(1, { duration: 500, easing: Easing.out(Easing.back(1.6)) }),
      );
      badgePulse.value = withDelay(
        900,
        withRepeat(withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }), -1, true),
      );
    }
    const tick = setInterval(() => setRemaining(getTimeRemaining()), 60000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value,
    transform: [{ scale: cardScale.value }],
  }));
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: badgeOpacity.value,
    transform: [{ scale: badgeScale.value * (1 + badgePulse.value * 0.08) }],
  }));

  if (!visible) return null;

  const openWhatToExpect = () => {
    setVisible(false);
    void Linking.openURL(`${MARKETING_URL}/what-to-expect`);
  };

  const countdownLabel = !remaining
    ? "It's launch day!"
    : remaining.days > 0
      ? `${remaining.days}d ${remaining.hours}h to go`
      : `${remaining.hours}h ${remaining.minutes}m to go`;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.6)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        }}
      >
        <Animated.View
          style={[
            cardStyle,
            {
              width: '100%',
              maxWidth: 380,
              backgroundColor: colors.bgSurface,
              borderRadius: radius.card,
              padding: spacing.xl,
              alignItems: 'center',
              gap: spacing.xs,
            },
          ]}
        >
          <Pressable
            onPress={() => setVisible(false)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{ position: 'absolute', top: spacing.md, right: spacing.md, padding: 4 }}
          >
            <Text variant="body" color="secondary">
              ✕
            </Text>
          </Pressable>

          <Animated.View
            style={[
              badgeStyle,
              {
                width: 64,
                height: 64,
                borderRadius: 32,
                backgroundColor: colors.bgSurfaceAlt,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: spacing.sm,
              },
            ]}
          >
            <Text variant="display">🚀</Text>
          </Animated.View>

          <Text variant="caption" color="brand" style={{ fontWeight: '700', letterSpacing: 1 }}>
            SOFT LAUNCH COUNTDOWN
          </Text>
          <Text variant="title" style={{ textAlign: 'center', marginTop: spacing.xs }}>
            InvolveMe opens {LAUNCH_DATE_LABEL}
          </Text>
          <Text
            variant="display"
            color="brand"
            style={{ marginTop: spacing.sm, textAlign: 'center' }}
          >
            {countdownLabel}
          </Text>
          <Text
            variant="body"
            color="secondary"
            style={{ textAlign: 'center', marginTop: spacing.sm }}
          >
            Get paid every time you reply to a message — no ads, no subscriptions, just real
            conversations that pay you back.
          </Text>

          <Pressable
            onPress={openWhatToExpect}
            accessibilityRole="button"
            style={{
              marginTop: spacing.lg,
              width: '100%',
              backgroundColor: colors.brandPrimary,
              borderRadius: radius.pill,
              paddingVertical: spacing.md,
              alignItems: 'center',
            }}
          >
            <Text variant="bodyMedium" color="inverse">
              See what to expect →
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setVisible(false)}
            style={{ marginTop: spacing.sm, padding: 4 }}
          >
            <Text variant="caption" color="secondary">
              Maybe later
            </Text>
          </Pressable>
        </Animated.View>
      </View>
    </Modal>
  );
}
