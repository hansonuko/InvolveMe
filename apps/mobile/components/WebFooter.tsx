import { Image, Linking, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from './ui/Text';

/**
 * involveme-web's own footer — this screen had none at all before (a bare
 * QR card floating on an empty canvas). Deliberately a single row of links
 * plus a copyright line, not a full multi-column site footer like
 * apps/marketing's own `Footer.tsx` — this is one utility screen (link a
 * device), not a multi-page site, so there's nothing to organize into
 * columns.
 *
 * "How it works"/"Privacy"/"Terms" all open the marketing site — the
 * Privacy/Terms routes do exist natively in this app
 * (app/legal/privacy.tsx, app/legal/terms.tsx), but `app/_layout.tsx`'s
 * useAuthGate bounces any unauthenticated session straight back to
 * `/(auth)` the instant it navigates anywhere outside that group —
 * exactly the state every visitor to this screen is in before they scan a
 * code. Linking out to the marketing site's own copy of the same
 * `@involveme/legal-content` package (same pattern this screen's header
 * menu already uses for "How it works") is the fix: a real, working page
 * instead of an internal route that can never open from here.
 */
export function WebFooter({ marketingUrl }: { marketingUrl: string }) {
  const { colors, spacing } = useTheme();

  const links = [
    { label: 'How it works', href: `${marketingUrl}/how-it-works` },
    { label: 'Privacy Policy', href: `${marketingUrl}/legal/privacy` },
    { label: 'Terms of Service', href: `${marketingUrl}/legal/terms` },
    { label: 'Download', href: `${marketingUrl}/download` },
  ];

  return (
    <View
      style={[
        styles.root,
        { borderTopColor: colors.borderSubtle, paddingVertical: spacing.xl, gap: spacing.lg },
      ]}
    >
      <View style={[styles.brandRow, { gap: spacing.sm }]}>
        <Image
          source={require('@/assets/images/icon.png')}
          style={{ width: 22, height: 22, borderRadius: 6 }}
          accessibilityIgnoresInvertColors
        />
        <Text variant="bodyMedium" color="secondary">
          InvolveMe
        </Text>
      </View>

      <View style={[styles.linkRow, { gap: spacing.xl }]}>
        {links.map((link) => (
          <Pressable key={link.label} onPress={() => void Linking.openURL(link.href)} hitSlop={6}>
            <Text variant="caption" color="tertiary">
              {link.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Text variant="caption" color="tertiary">
        © {new Date().getFullYear()} InvolveMe. All rights reserved.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderTopWidth: 1, alignItems: 'center', width: '100%' },
  brandRow: { flexDirection: 'row', alignItems: 'center' },
  linkRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center' },
});
