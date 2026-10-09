import { useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { usePwaInstallPrompt } from '@/lib/hooks/usePwaInstallPrompt';
import { useTheme } from '@/theme';

const DISMISSED_KEY = 'involveme-install-prompt-dismissed';

/** Everything here is knowable synchronously at mount (display mode, a
 * localStorage flag) — computed as the initial state itself rather than
 * via an effect that calls setState in its own body, which
 * `react-hooks/set-state-in-effect` correctly rejects (see
 * docs/00-SESSION-HANDOFF.md session 38 for why this rule is non-negotiable
 * here). The `beforeinstallprompt`/iOS-Safari detection itself now lives in
 * `usePwaInstallPrompt` (shared with `WebDevicePairingScreen`'s own
 * explicit "Install Web App" button) — this only needs the dismissal flag
 * and the already-installed short-circuit, both local to this banner. */
function computeInitialDismissed(): boolean {
  if (Platform.OS !== 'web') return true;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
  return window.localStorage.getItem(DISMISSED_KEY) === '1';
}

/** Web-only PWA install UX (docs/22-FULL-PWA-SCOPING.md §5/§9 Phase A) —
 * renders nothing on native, nothing once already installed, and nothing
 * if this device matches neither of the two cases that actually need a
 * nudge: Android/desktop Chrome (which can drive a real native install
 * prompt) and iOS Safari (which has no install-prompt API at all, only a
 * manual Share → Add to Home Screen flow). Mounted once in app/_layout.tsx,
 * same overlay posture OfflineBanner already establishes. */
export function InstallPwaPrompt() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(computeInitialDismissed);
  const { canInstall, promptInstall, isIosSafari } = usePwaInstallPrompt();

  if (Platform.OS !== 'web' || dismissed) return null;
  if (!canInstall && !isIosSafari) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  const install = async () => {
    const accepted = await promptInstall();
    if (accepted) dismiss();
  };

  return (
    <View
      style={[
        styles.container,
        {
          bottom: insets.bottom + spacing.md,
          left: spacing.md,
          right: spacing.md,
          backgroundColor: colors.bgSurface,
          borderRadius: radius.card,
          padding: spacing.md,
        },
      ]}
    >
      <View style={styles.row}>
        <Ionicons name="download-outline" size={22} color={colors.textSecondary} />
        <View style={styles.textCol}>
          {canInstall ? (
            <>
              <Text variant="bodyMedium">Install InvolveMe</Text>
              <Text variant="caption" color="tertiary">
                Add it to your home screen for the full app experience.
              </Text>
            </>
          ) : (
            <>
              <Text variant="bodyMedium">Add InvolveMe to your Home Screen</Text>
              <Text variant="caption" color="tertiary">
                Tap <Ionicons name="share-outline" size={14} color={colors.textTertiary} /> Share,
                then “Add to Home Screen”.
              </Text>
            </>
          )}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          onPress={dismiss}
          hitSlop={8}
        >
          <Ionicons name="close" size={20} color={colors.textTertiary} />
        </Pressable>
      </View>
      {canInstall ? (
        <Pressable
          accessibilityRole="button"
          onPress={install}
          style={[
            styles.installButton,
            {
              backgroundColor: colors.brandPrimary,
              borderRadius: radius.pill,
              marginTop: spacing.sm,
            },
          ]}
        >
          <Text variant="bodyMedium" color="inverse">
            Install
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    zIndex: 40,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  textCol: {
    flex: 1,
    gap: 2,
  },
  installButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
  },
});
