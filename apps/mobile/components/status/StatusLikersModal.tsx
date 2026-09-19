import { FlatList, Modal, Pressable, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { Text } from '@/components/ui/Text';
import { type StatusLiker } from '@/lib/queries/status';
import { useTheme } from '@/theme';

/** "3:45 PM" — same bare-clock-time format thread/[id].tsx's own
 * formatMessageTime uses for "what time" asks elsewhere in this app
 * (punch-list item 4's sent/read times), kept local here since it's this
 * component's only call site. */
function formatLikeTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Poster-only "who liked this status and when" (punch-list item 7,
 * 2026-09-19) — a plain full-height Modal, same "no bottom-sheet library"
 * call this app's other simple modals already make (ActionSheet's own
 * header comment). Deliberately its own small component, not inlined into
 * StoryViewer (already 500+ lines) — and deliberately a *separate*
 * trigger/surface from the delete action, which is this same punch-list
 * item's other half: "separate the status view feature from the delete
 * button decently so a user does not mistakenly tap the wrong feature." */
export function StatusLikersModal({
  visible,
  onClose,
  likers,
  isLoading,
}: {
  visible: boolean;
  onClose: () => void;
  likers: StatusLiker[];
  isLoading: boolean;
}) {
  const { colors, spacing } = useTheme();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: colors.bgCanvas, paddingTop: 56 }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.md,
          }}
        >
          <Text variant="title">Liked by</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        {isLoading ? (
          <View style={{ paddingTop: 48, alignItems: 'center' }}>
            <Text variant="body" color="tertiary">
              Loading…
            </Text>
          </View>
        ) : likers.length === 0 ? (
          <View style={{ paddingTop: 48, alignItems: 'center' }}>
            <Text variant="body" color="tertiary">
              No likes yet.
            </Text>
          </View>
        ) : (
          <FlatList
            data={likers}
            keyExtractor={(l) => l.id}
            contentContainerStyle={{ paddingHorizontal: spacing.lg }}
            renderItem={({ item }) => (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: spacing.sm,
                  gap: spacing.md,
                }}
              >
                <Avatar uri={item.avatar_url} displayName={item.display_name} size={44} />
                <Text variant="bodyMedium" style={{ flex: 1 }}>
                  {item.display_name ?? 'Unnamed'}
                </Text>
                <Text variant="caption" color="tertiary">
                  {formatLikeTime(item.liked_at)}
                </Text>
              </View>
            )}
          />
        )}
      </View>
    </Modal>
  );
}
