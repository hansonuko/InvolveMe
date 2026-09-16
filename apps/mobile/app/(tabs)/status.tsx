import { useEffect, useState } from 'react';
import { FlatList, Modal, Pressable, TextInput, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { AppHeader } from '@/components/ui/AppHeader';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import {
  useMarkStatusViewed,
  useMyStatusUpdates,
  usePostStatus,
  useStatusFeed,
  type StatusFeedGroup,
} from '@/lib/queries/status';
import { useTheme } from '@/theme';

/** Opens on tapping a poster's ring in the "Recent updates" row — lists
 * that poster's active captions newest-first and marks each shown status
 * viewed on open (v1 simplification: on open, not per-item scroll —
 * matches this screen's existing "no media viewer" scope, text captions
 * only). */
function StatusViewerModal({
  group,
  onClose,
}: {
  group: StatusFeedGroup | null;
  onClose: () => void;
}) {
  const { colors, spacing } = useTheme();
  const markViewed = useMarkStatusViewed();

  useEffect(() => {
    if (!group) return;
    for (const status of group.statuses) {
      markViewed.mutate(status.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.poster.id]);

  return (
    <Modal visible={!!group} animationType="fade" transparent onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'center',
          padding: spacing.lg,
        }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: colors.bgSurface,
            borderRadius: 16,
            padding: spacing.lg,
            gap: spacing.md,
          }}
        >
          <Text variant="title">{group?.poster.display_name ?? 'Status'}</Text>
          {group?.statuses.map((s) => (
            <View
              key={s.id}
              style={{
                paddingVertical: spacing.sm,
                borderBottomWidth: 1,
                borderBottomColor: colors.borderSubtle,
              }}
            >
              <Text variant="body">{s.caption}</Text>
              <Text variant="caption" color="secondary">
                {new Date(s.created_at).toLocaleString()}
              </Text>
            </View>
          ))}
          <Button label="Close" variant="secondary" onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function RecentUpdatesRow({ userId }: { userId: string | undefined }) {
  const { spacing } = useTheme();
  const { data: feed } = useStatusFeed(userId);
  const [openGroup, setOpenGroup] = useState<StatusFeedGroup | null>(null);

  if (!feed?.length) return null;

  return (
    <View style={{ marginBottom: spacing.xl }}>
      <Text variant="title" style={{ marginBottom: spacing.sm }}>
        Recent updates
      </Text>
      <FlatList
        horizontal
        showsHorizontalScrollIndicator={false}
        data={feed}
        keyExtractor={(g) => g.poster.id}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => setOpenGroup(item)}
            style={{ alignItems: 'center', width: 72, marginRight: spacing.sm }}
          >
            <Avatar
              uri={item.poster.avatar_url}
              displayName={item.poster.display_name}
              size={52}
              ringVariant={item.hasUnseen ? 'unseen' : 'seen'}
            />
            <Text
              variant="caption"
              color="secondary"
              numberOfLines={1}
              style={{ marginTop: spacing.xs }}
            >
              {item.poster.display_name ?? 'Someone'}
            </Text>
          </Pressable>
        )}
      />
      <StatusViewerModal group={openGroup} onClose={() => setOpenGroup(null)} />
    </View>
  );
}

/** Text-only status composer + own-status list, plus a "Recent updates"
 * row of thread partners' active statuses. Media upload (needs Supabase
 * Storage wiring) isn't built here — post-status's Edge Function already
 * supports a media_url, this screen just never sends one yet. */
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
      <AppHeader title="Status" />

      <RecentUpdatesRow userId={userId} />

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
