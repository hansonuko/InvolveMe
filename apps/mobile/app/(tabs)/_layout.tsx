import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';

import { useSession } from '@/lib/hooks/useSession';
import { useTotalUnreadCount } from '@/lib/queries/threads';
import { useTheme } from '@/theme';

/** Real vector icons (`@expo/vector-icons`, ships inside the Expo SDK —
 * added 2026-09-14, on an explicit "no colored icons, modern and
 * standard" ask) — replaces the earlier emoji glyphs. Emoji render in a
 * fixed native color no matter what `color` style is applied, which is
 * exactly the "colored icon" problem being fixed here; they'd also
 * render as a broken/missing-glyph "tofu" box on some Android font
 * configs, which is the most likely cause of "menu icons appear broken."
 * Ionicons tints correctly via the `color` prop React Navigation already
 * passes through `tabBarActiveTintColor`/`tabBarInactiveTintColor`, so no
 * per-icon color logic is needed here at all. */
const TAB_ICONS: Record<
  string,
  { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap }
> = {
  chats: { active: 'chatbubbles', inactive: 'chatbubbles-outline' },
  calls: { active: 'call', inactive: 'call-outline' },
  wallet: { active: 'wallet', inactive: 'wallet-outline' },
  // Matches the very first Status glyph used (a plain ring, '◎') before a
  // later mockup-driven pass swapped it for a tools icon — reverted back
  // on explicit request. A ring is also the right shape for "Status" in
  // this app's own docs/04-DESIGN-SYSTEM.md §4 motion spec ("Status ring:
  // animated gradient ring around avatars with unseen status").
  status: { active: 'ellipse', inactive: 'ellipse-outline' },
};

function TabIcon({
  route,
  color,
  focused,
  size,
}: {
  route: string;
  color: ColorValue;
  focused: boolean;
  size: number;
}) {
  const icons = TAB_ICONS[route];
  return (
    <Ionicons
      name={icons ? (focused ? icons.active : icons.inactive) : 'ellipse-outline'}
      size={size}
      color={color}
    />
  );
}

/**
 * WhatsApp-parity tab shell: Chats / Calls / Wallet (InvolveMe-specific, see
 * docs/04-DESIGN-SYSTEM.md §5) / Status.
 *
 * `headerShown: false` — each screen renders its own `AppHeader`
 * (components/ui/AppHeader.tsx).
 *
 * **2026-09-14 chrome correction:** the bar was a solid wine surface with
 * cream content (the original "Deep Wine" mockup's literal look) —
 * flagged back as backwards. Bars are now the canvas color (light milk /
 * dark near-black) with `textSecondary` (wine light, white dark) for the
 * active icon/label and `textTertiary` for inactive — text/icons carry
 * the accent, not the bar fill. See theme/tokens.ts's palette comment for
 * why the dark-mode accent is now plain white rather than the lightened
 * wine (`#C97D91`/`#B5677B`) that read as purple/mauve. Also taller
 * (`layout.barHeight`, ~0.6in) with bigger icons and a bigger label, on
 * an explicit size-up ask — no more focused-pill background behind the
 * icon; the icon/label color change alone carries the "active" state,
 * the same convention WhatsApp/Telegram's own tab bars actually use.
 */
export default function TabsLayout() {
  const { colors, typography, layout } = useTheme();
  const { session } = useSession();
  // Real count from thread_unread_counts (migration
  // 20260914080000_thread_read_cursor.sql) — undefined/0 renders no
  // badge at all, never a fabricated number.
  const { data: totalUnread } = useTotalUnreadCount(session?.user.id);

  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.bgCanvas,
          borderTopColor: colors.borderSubtle,
          height: layout.barHeight,
          paddingTop: 12,
        },
        tabBarActiveTintColor: colors.textSecondary,
        tabBarInactiveTintColor: colors.textTertiary,
        tabBarLabelStyle: typography.tabBarLabel,
        tabBarIcon: ({ color, focused }) => (
          <TabIcon route={route.name} color={color} focused={focused} size={layout.tabIconSize} />
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
