import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { useProfile } from '@/lib/queries/profile';
import { unregisterPushToken } from '@/lib/push';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme';

/** One tappable row in the Settings hub — an icon, a label, and a chevron.
 * Every section below (Account, Privacy, Notifications, Appearance, Help)
 * is its own screen reached this way, per punch-list item 2's "Profile
 * should be clicked, before it opens the profile section... rather than
 * just listing everything" ask — the old version of this screen was one
 * long flat list of every setting at once. */
function SettingsRow({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
          paddingVertical: spacing.md,
          borderRadius: radius.card,
          backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
        },
      ]}
    >
      <View
        style={{
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.bgSurfaceAlt,
        }}
      >
        <Ionicons name={icon} size={18} color={colors.textSecondary} />
      </View>
      <Text variant="body" style={{ flex: 1 }}>
        {label}
      </Text>
      <Text color="tertiary">›</Text>
    </Pressable>
  );
}

/** Sign-out + the Settings hub. Bank-account linking lives in the Wallet
 * tab instead (a wallet action, not account-level settings). */
export default function SettingsScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: profile } = useProfile(userId);

  const handleSignOut = async () => {
    await unregisterPushToken();
    await supabase.auth.signOut();
    router.replace('/(auth)');
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Settings',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: spacing.xl }}
        >
          {/* Profile preview — the whole row is the entry point into the
              full profile editor, same "tap your own name/photo to edit
              it" pattern every reference app uses instead of burying it
              in a submenu. */}
          <Pressable
            onPress={() => router.push('/settings/profile')}
            style={({ pressed }) => [
              {
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                paddingVertical: spacing.lg,
                backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
              },
            ]}
          >
            <Avatar uri={profile?.avatar_url} displayName={profile?.display_name} size={64} />
            <View style={{ flex: 1 }}>
              <Text variant="title">{profile?.display_name ?? 'Add your name'}</Text>
              {profile?.status_text ? (
                <Text variant="caption" color="tertiary" numberOfLines={1}>
                  {profile.status_text}
                </Text>
              ) : null}
            </View>
            <Text color="tertiary">›</Text>
          </Pressable>

          <View style={{ marginTop: spacing.md }}>
            <SettingsRow
              icon="shield-checkmark-outline"
              label="Account"
              onPress={() => router.push('/settings/account')}
            />
            <SettingsRow
              icon="lock-closed-outline"
              label="Privacy"
              onPress={() => router.push('/settings/privacy')}
            />
            <SettingsRow
              icon="notifications-outline"
              label="Notifications"
              onPress={() => router.push('/settings/notifications')}
            />
            <SettingsRow
              icon="color-palette-outline"
              label="Appearance"
              onPress={() => router.push('/settings/appearance')}
            />
            <SettingsRow
              icon="help-circle-outline"
              label="Help"
              onPress={() => router.push('/settings/help')}
            />
          </View>

          <Button
            label="Sign out"
            variant="secondary"
            onPress={handleSignOut}
            style={{ marginTop: spacing.xl }}
          />
        </ScrollView>
      </Screen>
    </>
  );
}
