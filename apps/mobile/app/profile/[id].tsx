import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { usePublicProfile } from '@/lib/queries/profile';
import { useTheme } from '@/theme';

/** Minimal read-only profile view — reached from a chat-row avatar's
 * "Profile" action (see chats.tsx's ThreadRow). `threadId` is an optional
 * param: entry points that already know a thread id (like the chat list,
 * where a thread already exists with this person) pass it through so
 * "Message" can jump straight there; entry points that don't have one yet
 * just don't show that button, rather than guessing at one. */
export default function ProfileScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { id, threadId } = useLocalSearchParams<{ id: string; threadId?: string }>();
  const { data: profile, isLoading } = usePublicProfile(id);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Profile',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen>
        {isLoading ? (
          <Text variant="body" color="secondary">
            Loading…
          </Text>
        ) : !profile ? (
          // A genuinely honest state, not a silently-blank card — the most
          // common real cause is `users_select_own_or_thread_partner` RLS
          // (docs/02-DATA-MODEL.md §2) returning nothing because no thread
          // exists with this person yet, not a crash or a loading glitch.
          <View style={{ alignItems: 'center', marginTop: spacing.xxl, gap: spacing.sm }}>
            <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
              This profile isn&apos;t available.
            </Text>
          </View>
        ) : (
          <View style={{ alignItems: 'center', marginTop: spacing.xxl, gap: spacing.sm }}>
            <Avatar uri={profile.avatar_url} displayName={profile.display_name} size={120} />
            <Text variant="title" style={{ marginTop: spacing.md }}>
              {profile.display_name ?? 'Unnamed'}
            </Text>
            {profile.status_text ? (
              <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
                {profile.status_text}
              </Text>
            ) : null}

            {threadId ? (
              <Button
                label="Message"
                onPress={() => router.push(`/thread/${threadId}`)}
                style={{ marginTop: spacing.xl, minWidth: 160 }}
              />
            ) : null}
          </View>
        )}
      </Screen>
    </>
  );
}
