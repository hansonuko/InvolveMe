import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/ui/Text';
import { useTheme } from '@/theme';

const DISMISSED_KEY = 'involveme-install-prompt-dismissed';

/** Chrome's own install-prompt event — not in TS's standard DOM lib yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandaloneDisplay() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari's own non-standard flag — `display-mode: standalone`
    // isn't reliably reported there even once actually installed.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari() {
  const ua = window.navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // Every iOS browser (Chrome, Firefox, etc.) is a WebKit wrapper that
  // still reports "Safari" in its UA, so excluding "CriOS"/"FxiOS" is
  // required to not fire this for, say, iOS Chrome too.
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari;
}

/** Everything here is knowable synchronously at mount (display mode, a
 * localStorage flag, the UA string) — computed as the initial state itself
 * rather than via an effect that calls setState in its own body, which
 * `react-hooks/set-state-in-effect` correctly rejects (see
 * docs/00-SESSION-HANDOFF.md session 38 for why this rule is non-negotiable
 * here). Only `deferredPrompt` below is genuinely effect-driven, since it
 * really is a subscription to an external event. */
function computeInitialState(): { dismissed: boolean; showIosInstructions: boolean } {
  if (Platform.OS !== 'web') return { dismissed: true, showIosInstructions: false };
  if (isStandaloneDisplay()) return { dismissed: true, showIosInstructions: false };
  if (window.localStorage.getItem(DISMISSED_KEY) === '1') {
    return { dismissed: true, showIosInstructions: false };
  }
  return { dismissed: false, showIosInstructions: isIosSafari() };
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
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [{ dismissed, showIosInstructions }, setUiState] = useState(computeInitialState);

  useEffect(() => {
    if (Platform.OS !== 'web' || dismissed) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, [dismissed]);

  if (Platform.OS !== 'web' || dismissed) return null;
  if (!deferredPrompt && !showIosInstructions) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISSED_KEY, '1');
    setUiState((s) => ({ ...s, dismissed: true }));
  };

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') dismiss();
    setDeferredPrompt(null);
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
          {deferredPrompt ? (
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
      {deferredPrompt ? (
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
