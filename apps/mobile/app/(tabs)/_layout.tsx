import { Tabs } from 'expo-router';

import { useTheme } from '@/theme';

/**
 * WhatsApp-parity tab shell: Chats / Status / Wallet (InvolveMe-specific,
 * see docs/04-DESIGN-SYSTEM.md §5) / Calls (stubbed, out of v1 scope per
 * docs/08-BUILD-PHASES-ROADMAP.md).
 */
export default function TabsLayout() {
  const { colors } = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.bgSurface },
        headerTintColor: colors.textPrimary,
        tabBarStyle: { backgroundColor: colors.bgSurface, borderTopColor: colors.borderSubtle },
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.textSecondary,
      }}
    >
      <Tabs.Screen name="chats" options={{ title: 'Chats' }} />
      <Tabs.Screen name="status" options={{ title: 'Status' }} />
      <Tabs.Screen name="wallet" options={{ title: 'Wallet' }} />
      <Tabs.Screen name="calls" options={{ title: 'Calls' }} />
    </Tabs>
  );
}
