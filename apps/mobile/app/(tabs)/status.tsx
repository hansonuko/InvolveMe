import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { AppHeader } from '@/components/ui/AppHeader';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { StatusComposer } from '@/components/status/StatusComposer';
import { StoryViewer } from '@/components/status/StoryViewer';
import { useSession } from '@/lib/hooks/useSession';
import { useDeleteStatus, useMyStatusUpdates, useStatusFeed } from '@/lib/queries/status';
import { useTheme } from '@/theme';

/** Horizontal "Recent updates" row of thread partners' active statuses —
 * tapping a ring opens the full-screen StoryViewer at that poster's index,
 * per docs/10-UX-REFINEMENT-BACKLOG.md Batch F item 6's "swipe-through"
 * (swiping inside the viewer moves between posters; this row just picks
 * the starting one). */
function RecentUpdatesRow({ userId }: { userId: string | undefined }) {
  const { spacing } = useTheme();
  const { data: feed } = useStatusFeed(userId);
  const [openPosterIndex, setOpenPosterIndex] = useState<number | null>(null);

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
        renderItem={({ item, index }) => (
          <Pressable
            onPress={() => setOpenPosterIndex(index)}
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
      {openPosterIndex !== null ? (
        <StoryViewer
          feed={feed}
          initialPosterIndex={openPosterIndex}
          currentUserId={userId}
          onClose={() => setOpenPosterIndex(null)}
        />
      ) : null}
    </View>
  );
}

/** Own-status composer entry point + own-status list. Media/text-template
 * posting goes through the full-screen StatusComposer (Batch F) — this
 * screen only ever opens it and lists what's already posted. */
export default function StatusScreen() {
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: statuses, isLoading } = useMyStatusUpdates(userId);
  const deleteStatus = useDeleteStatus();
  const [composerVisible, setComposerVisible] = useState(false);

  return (
    <Screen>
      <AppHeader title="Status" />

      <RecentUpdatesRow userId={userId} />

      <View style={{ marginBottom: spacing.xl }}>
        <Button label="New status update" onPress={() => setComposerVisible(true)} />
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
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: colors.borderSubtle,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text variant="body">
                  {item.caption ?? (item.media_path ? 'Photo status' : '')}
                </Text>
                <Text variant="caption" color="secondary">
                  {item.credits_charged} cr · expires {new Date(item.expires_at).toLocaleString()}
                </Text>
              </View>
              <Pressable
                onPress={() => deleteStatus.mutate({ id: item.id, media_path: item.media_path })}
                hitSlop={8}
                style={{
                  padding: spacing.sm,
                  borderRadius: radius.card,
                }}
              >
                <Ionicons name="trash-outline" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
          )}
        />
      )}

      <StatusComposer visible={composerVisible} onClose={() => setComposerVisible(false)} />
    </Screen>
  );
}
