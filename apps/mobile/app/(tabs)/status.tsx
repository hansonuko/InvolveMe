import { useState } from 'react';
import { FlatList, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { useMyStatusUpdates, usePostStatus } from '@/lib/queries/status';
import { useTheme } from '@/theme';

/** Text-only status composer + own-status list. Media upload (needs
 * Supabase Storage wiring) isn't built here — post-status's Edge Function
 * already supports a media_url, this screen just never sends one yet. */
export default function StatusScreen() {
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: statuses, isLoading } = useMyStatusUpdates(userId);
  const postStatus = usePostStatus();
  const [caption, setCaption] = useState('');

  const handlePost = () => {
    if (!caption.trim()) return;
    postStatus.mutate(caption, { onSuccess: () => setCaption('') });
  };

  return (
    <Screen>
      <Text variant="display" style={{ marginBottom: spacing.lg }}>
        Status
      </Text>

      <View style={{ gap: spacing.sm, marginBottom: spacing.xl }}>
        <TextInput
          value={caption}
          onChangeText={setCaption}
          placeholder="What's on your mind?"
          placeholderTextColor={colors.textSecondary}
          multiline
          style={{
            borderWidth: 1,
            borderColor: colors.borderSubtle,
            backgroundColor: colors.bgSurfaceAlt,
            color: colors.textPrimary,
            borderRadius: radius.card,
            paddingHorizontal: 16,
            paddingVertical: 14,
            fontSize: 16,
            minHeight: 60,
            textAlignVertical: 'top',
          }}
        />
        {postStatus.isError ? (
          <Text variant="caption" color="danger">
            {postStatus.error.message}
          </Text>
        ) : null}
        <Button
          label={postStatus.isPending ? 'Posting…' : 'Post status'}
          onPress={handlePost}
          disabled={postStatus.isPending || !caption.trim()}
        />
      </View>

      {isLoading ? (
        <Text variant="body" color="secondary">
          Loading…
        </Text>
      ) : !statuses?.length ? (
        <Text variant="body" color="secondary">
          No status updates yet.
        </Text>
      ) : (
        <FlatList
          data={statuses}
          keyExtractor={(s) => s.id}
          renderItem={({ item }) => (
            <View
              style={{
                paddingVertical: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: colors.borderSubtle,
              }}
            >
              <Text variant="body">{item.caption}</Text>
              <Text variant="caption" color="secondary">
                {item.credits_charged} cr · expires {new Date(item.expires_at).toLocaleString()}
              </Text>
            </View>
          )}
        />
      )}
    </Screen>
  );
}
