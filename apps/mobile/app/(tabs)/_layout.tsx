import { Tabs } from 'expo-router';
import { StyleSheet, View, type ColorValue } from 'react-native';

import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { useTotalUnreadCount } from '@/lib/queries/threads';
import { useTheme } from '@/theme';

/** Bold, single-glyph tab icons — no vector-icon package is installed in
 * this project yet (`@expo/vector-icons` isn't in node_modules; adding it
 * would be a new dependency, not something already covered per CLAUDE.md's
 * "stay lite" rule), so these are rendered through the existing `Text`
 * primitive rather than pulling one in for this alone. Filled vs. plain
 * glyph gives the same "bolder when active" read a filled/outline icon pair
 * normally would. */
const TAB_GLYPHS: Record<string, string> = {
  chats: '💬',
  calls: '📞',
  wallet: '👛',
  status: '🛠',
};

function TabIcon({
  route,
  color,
  focused,
}: {
  route: string;
  color: ColorValue;
  focused: boolean;
}) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View
      style={[
        styles.iconPill,
        {
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs,
          borderRadius: radius.pill,
          // Focused tab gets a lighter-wine pill behind it — the bottom bar
          // itself is a solid wine surface (see tabBarStyle below), so this
          // needs to read as a step lighter than that, not just an opacity
          // tint on the same hue.
          backgroundColor: focused ? colors.brandPrimaryPressed : 'transparent',
        },
      ]}
    >
      <Text
        style={{ fontSize: 20, color }}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {TAB_GLYPHS[route] ?? '•'}
      </Text>
    </View>
  );
}

/**
 * WhatsApp-parity tab shell: Chats / Calls / Wallet (InvolveMe-specific, see
 * docs/04-DESIGN-SYSTEM.md §5) / Status, in that order per the 2026-09-13
 * wine rebrand spec (docs/00-SESSION-HANDOFF.md) — previously Chats /
 * Status / Wallet / Calls.
 *
 * `headerShown: false` — each screen now renders its own `AppHeader`
 * (components/ui/AppHeader.tsx). Before this, Expo Router's own default
 * `Tabs` header rendered *underneath* every screen's custom title, since
 * nothing had ever turned it off — two stacked headers on every tab. See
 * docs/00-SESSION-HANDOFF.md's header/nav overhaul section.
 */
export default function TabsLayout() {
  const { colors, typography } = useTheme();
  const { session } = useSession();
  // Real count from thread_unread_counts (migration
  // 20260914080000_thread_read_cursor.sql) — undefined/0 renders no
  // badge at all, never a fabricated number.
  const { data: totalUnread } = useTotalUnreadCount(session?.user.id);

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        // The tab bar itself is a solid wine surface with cream icons/labels
        // regardless of light/dark app theme — `textInverse`/`brandPrimary`
        // are the "always on brand" tokens for exactly this (see
        // theme/tokens.ts's 2026-09-13 rebrand comment).
        tabBarStyle: { backgroundColor: colors.brandPrimary, borderTopColor: colors.brandPrimary },
        tabBarActiveTintColor: colors.textInverse,
        tabBarInactiveTintColor: colors.textInverse,
        tabBarLabelStyle: typography.tabBarLabel,
        tabBarIcon: ({ color, focused }) => (
          <TabIcon route={route.name} color={color} focused={focused} />
        ),
      })}
    >
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chats',
          tabBarBadge: totalUnread ? totalUnread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.badgeBg, color: colors.badgeText },
        }}
      />
      <Tabs.Screen name="calls" options={{ title: 'Calls' }} />
      <Tabs.Screen name="wallet" options={{ title: 'Wallet' }} />
      <Tabs.Screen name="status" options={{ title: 'Status' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconPill: { alignItems: 'center', justifyContent: 'center' },
});
