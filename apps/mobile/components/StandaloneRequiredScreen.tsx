import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { usePwaInstallPrompt } from '@/lib/hooks/usePwaInstallPrompt';
import { showAlert } from '@/lib/ui/alert';
import { useTheme } from '@/theme';

const LINK_DEVICE_URL = 'https://web.involvemechat.com';

/**
 * app.involvemechat.com's desktop-only entry gate — mounted at the root of
 * the app (app/_layout.tsx), replacing the entire route tree, not just the
 * login screen. **Mobile visitors never see this** (`app/_layout.tsx`'s own
 * `needsPwaInstall` check excludes `isMobileWeb()`) — this domain exists
 * specifically for new users with no other path in (iOS, any device
 * without store access), so gating mobile behind an install wall would
 * defeat the entire point. Desktop is the one case still gated: per
 * explicit product requirement, this app must never be directly usable
 * from a desktop browser tab, only once installed. Rendering this at the
 * root (rather than just inside `app/(auth)/index.tsx`) closes the edge
 * case a login-screen-only gate would miss — a desktop tab that already
 * holds a valid session (e.g. the same browser profile reopened as a plain
 * tab after installing once) would otherwise sail straight past login
 * without ever having been "installed" in this tab's own context.
 *
 * `usePwaInstallPrompt`'s `isAlreadyInstalled` is what `app/_layout.tsx`
 * itself checks before even mounting this component — by the time this
 * renders, the device is confirmed desktop and not-yet-installed, so this
 * only ever needs the real `beforeinstallprompt` path (desktop Chrome/Edge
 * support it; no iOS-Safari-style manual-instructions case applies here).
 */
export function StandaloneRequiredScreen() {
  const { spacing, radius } = useTheme();
  const { canInstall, promptInstall } = usePwaInstallPrompt();

  const handleInstall = async () => {
    if (canInstall) {
      await promptInstall();
      return;
    }
    showAlert(
      'Install not available yet',
      'Look for an install icon in your browser’s address bar, or check back in a moment.',
    );
  };

  return (
    <Screen style={styles.root}>
      <View style={styles.content}>
        <Image
          source={require('@/assets/images/icon.png')}
          style={[styles.icon, { borderRadius: radius.card }]}
          accessibilityIgnoresInvertColors
        />
        <Text variant="display" color="secondary" style={styles.title}>
          Install InvolveMe to continue
        </Text>
        <Text variant="body" color="secondary" style={styles.body}>
          On desktop, InvolveMe only runs once it’s installed — not as a regular browser tab. On a
          phone, it just works directly.
        </Text>

        <Button
          label={canInstall ? 'Install InvolveMe' : 'How to install'}
          onPress={() => void handleInstall()}
          style={{ marginTop: spacing.xl }}
        />

        <Text variant="caption" color="tertiary" style={[styles.body, { marginTop: spacing.xxl }]}>
          Already using InvolveMe on your phone? This device doesn’t need its own account — link it
          as a companion instead.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => void Linking.openURL(LINK_DEVICE_URL)}
          hitSlop={8}
          style={{ marginTop: spacing.sm }}
        >
          <Text variant="bodyMedium" color="brand">
            Link this device instead
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    maxWidth: 420,
    alignSelf: 'center',
  },
  icon: { width: 72, height: 72, marginBottom: 12 },
  title: { textAlign: 'center' },
  body: { textAlign: 'center' },
});
