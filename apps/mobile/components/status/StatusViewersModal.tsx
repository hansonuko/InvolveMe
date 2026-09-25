import { Ionicons } from '@expo/vector-icons';
import { FlatList, Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Avatar } from '@/components/ui/Avatar';
import { Text } from '@/components/ui/Text';
import { type StatusViewer } from '@/lib/queries/status';
import { useTheme } from '@/theme';

/** "3:45 PM" — same bare-clock-time format thread/[id].tsx's own
 * formatMessageTime uses for "what time" asks elsewhere in this app,
 * kept local here since it's this component's only call site. */
function formatViewTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Poster-only "who viewed this status" — one combined list, WhatsApp's
 * own shape: tapping the eye icon shows every viewer, with a small heart
 * next to whichever ones also liked it, rather than a separate "liked by"
 * button/modal (that used to be `StatusLikersModal`, now folded in here —
 * a viewer either liked or didn't, shown inline, not as its own surface a
 * user could tap into by mistake).
 *
 * docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A2 — a half-screen
 * bottom sheet (WhatsApp's own shape for this exact list), not a full-
 * screen takeover. The `FlatList` underneath is unchanged — it already
 * scrolled fine, it just needed a bounded-height container to scroll
 * *within* instead of a screen to fill. */
export function StatusViewersModal({
  visible,
  onClose,
  viewers,
  isLoading,
}: {
  visible: boolean;
  onClose: () => void;
  viewers: StatusViewer[];
  isLoading: boolean;
}) {
  const { colors, spacing, radius } = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {/* Tap the backdrop (anything above the sheet) to dismiss — the sheet
          itself is a separate, non-dismissing Pressable-free View so taps
          on the list/header don't fall through to this. */}
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close"
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            maxHeight: windowHeight * 0.55,
            backgroundColor: colors.bgCanvas,
            borderTopLeftRadius: radius.sheet,
            borderTopRightRadius: radius.sheet,
            paddingBottom: insets.bottom + spacing.md,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.md,
              paddingBottom: spacing.md,
            }}
          >
            <Text variant="title">Viewed by</Text>
            <Pressable onPress={onClose} hitSlop={12}>
              <Text variant="body" color="secondary">
                Close
              </Text>
            </Pressable>
          </View>

          {isLoading ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}>
              <Text variant="body" color="tertiary">
                Loading…
              </Text>
            </View>
          ) : viewers.length === 0 ? (
            <View style={{ paddingVertical: 48, alignItems: 'center' }}>
              <Text variant="body" color="tertiary">
                No views yet.
              </Text>
            </View>
          ) : (
            <FlatList
              data={viewers}
              keyExtractor={(v) => v.id}
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
                  {item.liked_at ? (
                    <Ionicons name="heart" size={16} color={colors.brandPrimary} />
                  ) : null}
                  <Text variant="caption" color="tertiary">
                    {formatViewTime(item.viewed_at)}
                  </Text>
                </View>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
