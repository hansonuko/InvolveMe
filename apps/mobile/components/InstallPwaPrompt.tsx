import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { usePwaInstallPrompt } from '@/lib/hooks/usePwaInstallPrompt';
import { MARKETING_URL } from '@/lib/marketingUrl';
import { isAndroidWeb, isFullPwaHost, isMobileWeb } from '@/lib/webAppMode';
import { showAlert } from '@/lib/ui/alert';
import { useTheme } from '@/theme';

const DISMISSED_KEY = 'involveme-install-prompt-dismissed';
const FULL_PWA_URL = 'https://app.involvemechat.com';

/** Everything here is knowable synchronously at mount (display mode, a
 * localStorage flag) — computed as the initial state itself rather than
 * via an effect that calls setState in its own body, which
 * `react-hooks/set-state-in-effect` correctly rejects (see
 * docs/00-SESSION-HANDOFF.md session 38 for why this rule is non-negotiable
 * here). Still relevant even though this banner no longer self-installs
 * anything (see this component's own header comment): a tab already
 * running standalone (e.g. `app.involvemechat.com`, installed) has no use
 * for a "get the full app" nudge either. */
function computeInitialDismissed(): boolean {
  if (Platform.OS !== 'web') return true;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
  return window.localStorage.getItem(DISMISSED_KEY) === '1';
}

/**
 * Web-only install UX (docs/22-FULL-PWA-SCOPING.md §5/§9 Phase A,
 * revived at a separate subdomain per session 45 continued) — mounted
 * once in app/_layout.tsx, same overlay posture OfflineBanner already
 * establishes. Three different jobs depending on which host/device is
 * actually serving this page:
 *
 * - `app.involvemechat.com` on desktop: renders nothing — `app/_layout.
 *   tsx`'s own `needsPwaInstall` gate already shows a full-screen,
 *   impossible-to-miss install requirement there before this banner would
 *   ever get a chance to; a second, smaller nudge stacked on top of it
 *   would just be noise.
 * - `app.involvemechat.com` on mobile: this *is* the real standalone app,
 *   reachable directly with no install wall (the entire point of offering
 *   it there), but nothing was nudging a first-time mobile visitor to
 *   actually add it to their home screen either — this renders that nudge,
 *   using the exact same `usePwaInstallPrompt` the hard desktop gate uses
 *   (real `beforeinstallprompt` on Android; manual Share-sheet copy on iOS
 *   Safari, which has no such API).
 * - Everywhere else (`web.involvemechat.com`'s QR-pairing companion,
 *   `involveme-web.pages.dev`, localhost): this is NOT the installable
 *   standalone app, so the banner's job is promoting the *other* one
 *   instead — "get the full app" pointing at `app.involvemechat.com`, with
 *   an Android-specific message since the native Android app (still
 *   APK-sideload-only, not yet store-listed) is the one case where this
 *   companion-domain install prompt isn't the right answer.
 */
export function InstallPwaPrompt() {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const [dismissed, setDismissed] = useState(computeInitialDismissed);
  const { canInstall, promptInstall, isIosSafari } = usePwaInstallPrompt();

  if (Platform.OS !== 'web' || dismissed) return null;

  const onFullPwaHost = isFullPwaHost();
  // Desktop on app.involvemechat.com already gets the hard full-screen
  // gate (app/_layout.tsx's needsPwaInstall) — this banner only has a job
  // there on mobile, which that gate deliberately excludes.
  if (onFullPwaHost && !isMobileWeb()) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, '1');
    setDismissed(true);
  };

  const isAndroid = isAndroidWeb();

  const install = async () => {
    if (onFullPwaHost) {
      // Already on the standalone app's own origin — the real
      // `beforeinstallprompt` (Android/desktop Chrome) fires here
      // directly, no cross-origin redirect needed.
      if (canInstall) {
        await promptInstall();
        return;
      }
      if (isIosSafari) {
        showAlert(
          'Add to Home Screen',
          'Tap the Share icon, then "Add to Home Screen" to install InvolveMe.',
        );
        return;
      }
      showAlert(
        'Install not available yet',
        'Look for an install icon in your browser’s address bar, or check back in a moment.',
      );
      return;
    }
    if (isAndroid) {
      void Linking.openURL(`${MARKETING_URL}/download`);
      return;
    }
    // Opens the real standalone app's own domain rather than trying to
    // drive its `beforeinstallprompt` from here — that event only ever
    // fires on the origin it was dispatched for, which this page (a
    // different domain) never receives.
    void Linking.openURL(FULL_PWA_URL);
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
          <Text variant="bodyMedium">
            {onFullPwaHost ? 'Add InvolveMe to your Home Screen' : 'Get the full InvolveMe app'}
          </Text>
          {onFullPwaHost ? (
            <Text variant="caption" color="tertiary">
              Keep InvolveMe one tap away — add it to your home screen like any other app.
            </Text>
          ) : isAndroid ? (
            <Text variant="caption" color="tertiary">
              {
                "Not on the Play Store yet — get the Android app directly, or we'll notify you the moment it's there."
              }
            </Text>
          ) : (
            <Text variant="caption" color="tertiary">
              {
                "Not on Android? Install the web app for the complete experience — we'll notify you when the native app is ready for your store."
              }
            </Text>
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
      <Pressable
        accessibilityRole="button"
        onPress={() => void install()}
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
          {onFullPwaHost
            ? 'Add to Home Screen'
            : isAndroid
              ? 'Get the Android app'
              : 'Install the web app'}
        </Text>
      </Pressable>
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
