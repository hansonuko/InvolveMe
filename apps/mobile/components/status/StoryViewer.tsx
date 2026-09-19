import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { ActionSheet } from '@/components/ui/ActionSheet';
import { Avatar } from '@/components/ui/Avatar';
import { useKeyboardHeight } from '@/components/ui/KeyboardAvoidingScreen';
import { StatusLikersModal } from '@/components/status/StatusLikersModal';
import { Text } from '@/components/ui/Text';
import { useSendMessage } from '@/lib/queries/messages';
import {
  useDeleteStatus,
  useMarkStatusViewed,
  useStatusLiked,
  useStatusLikers,
  useStatusMediaUrl,
  useStatusViewCount,
  useToggleStatusLike,
  type StatusFeedGroup,
  type StatusUpdate,
} from '@/lib/queries/status';
import { useStartThread } from '@/lib/queries/threads';
import { formatStatusAge } from '@/lib/statusAge';
import { getStatusTextTemplate } from '@/lib/statusTextTemplates';
import { useTheme } from '@/theme';

const ITEM_DURATION_MS = 6000; // docs/10-UX-REFINEMENT-BACKLOG.md Batch F item 3 — "6 seconds per item, confirmed"

/**
 * Full-screen story viewer (docs/10-UX-REFINEMENT-BACKLOG.md Batch F items
 * 3, 4, 5, 6, 7) — replaces the old centered-dialog `StatusViewerModal`.
 * One poster per horizontally-paged screen (native `FlatList`
 * `pagingEnabled`, not a custom `PanGestureHandler` — swiping between
 * posters is exactly what paging scroll already does natively, with none
 * of the gesture-conflict edge cases a hand-rolled pan gesture would need
 * to handle against the tap-to-advance zones below). Within a poster,
 * items auto-advance every 6s (progress bars at top) or on a tap; tapping
 * the left third goes back, the right two-thirds goes forward — advancing
 * past a poster's last item moves to the next page (or closes, on the
 * last poster), matching the reference apps' pattern.
 */
export function StoryViewer({
  feed,
  initialPosterIndex,
  currentUserId,
  onClose,
}: {
  feed: StatusFeedGroup[];
  initialPosterIndex: number;
  currentUserId: string | undefined;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<StatusFeedGroup>>(null);
  const [posterIndex, setPosterIndex] = useState(initialPosterIndex);
  const [itemIndex, setItemIndex] = useState(0);
  // Paused while the reply input is focused (punch-list item 4a,
  // 2026-09-19) — auto-advancing to the next status while someone is
  // mid-reply would silently discard their attention, the same "don't
  // interrupt active input" instinct KeyboardAvoidingScreen's own
  // keyboard-tracking respects elsewhere in this app.
  const [isReplyFocused, setIsReplyFocused] = useState(false);
  const markViewed = useMarkStatusViewed();
  const markedRef = useRef<Set<string>>(new Set());

  const activeGroup = feed[posterIndex];
  const activeStatus = activeGroup?.statuses[itemIndex];
  const isOwnStatus = !!activeStatus && activeGroup.poster.id === currentUserId;

  const advance = (direction: 1 | -1) => {
    const group = feed[posterIndex];
    if (!group) return;
    const nextItemIndex = itemIndex + direction;

    if (nextItemIndex >= 0 && nextItemIndex < group.statuses.length) {
      setItemIndex(nextItemIndex);
      return;
    }

    const nextPosterIndex = posterIndex + direction;
    if (nextPosterIndex < 0 || nextPosterIndex >= feed.length) {
      onClose();
      return;
    }
    setPosterIndex(nextPosterIndex);
    setItemIndex(direction === 1 ? 0 : feed[nextPosterIndex].statuses.length - 1);
    listRef.current?.scrollToIndex({ index: nextPosterIndex, animated: true });
  };

  // Mark viewed once per status shown, not once per render — a status
  // already marked this session doesn't need a redundant network call
  // (fn_mark_status_viewed is idempotent server-side too, this just saves
  // the round trip).
  useEffect(() => {
    if (!activeStatus || isOwnStatus) return;
    if (markedRef.current.has(activeStatus.id)) return;
    markedRef.current.add(activeStatus.id);
    markViewed.mutate(activeStatus.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStatus?.id, isOwnStatus]);

  // 6s auto-advance, reset on every item/poster change — paused while
  // replying (see isReplyFocused's own comment above).
  useEffect(() => {
    if (!activeStatus || isReplyFocused) return;
    const timer = setTimeout(() => advance(1), ITEM_DURATION_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posterIndex, itemIndex, isReplyFocused]);

  const handleMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const newIndex = Math.round(e.nativeEvent.contentOffset.x / width);
    if (newIndex !== posterIndex) {
      setPosterIndex(newIndex);
      setItemIndex(0);
    }
  };

  if (!activeGroup) return null;

  return (
    <Modal visible animationType="fade" onRequestClose={onClose}>
      <FlatList
        ref={listRef}
        data={feed}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(g) => g.poster.id}
        initialScrollIndex={initialPosterIndex}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        renderItem={({ item, index }) => (
          <PosterPage
            group={item}
            width={width}
            itemIndex={index === posterIndex ? itemIndex : 0}
            isActive={index === posterIndex}
            isOwn={item.poster.id === currentUserId}
            currentUserId={currentUserId}
            onAdvance={advance}
            onClose={onClose}
            onReplyFocusChange={setIsReplyFocused}
          />
        )}
      />
    </Modal>
  );
}

function PosterPage({
  group,
  width,
  itemIndex,
  isActive,
  isOwn,
  currentUserId,
  onAdvance,
  onClose,
  onReplyFocusChange,
}: {
  group: StatusFeedGroup;
  width: number;
  itemIndex: number;
  isActive: boolean;
  isOwn: boolean;
  currentUserId: string | undefined;
  onAdvance: (direction: 1 | -1) => void;
  onClose: () => void;
  onReplyFocusChange: (focused: boolean) => void;
}) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const status = group.statuses[itemIndex];
  const viewCount = useStatusViewCount(isOwn && isActive ? status?.id : undefined);
  const likers = useStatusLikers(isOwn && isActive ? status?.id : undefined);
  const [showViewCount, setShowViewCount] = useState(false);
  const [likersModalOpen, setLikersModalOpen] = useState(false);
  // Overflow menu for delete (punch-list item 7, 2026-09-19) — physically
  // separated from the view/likes controls at the bottom of the screen
  // (lives in the header instead, next to Close) specifically so a tap
  // meant for "show who's viewed/liked this" can never land on "delete"
  // by mistake; a confirm dialog on top of that means even a genuine tap
  // on Delete still isn't instantly destructive.
  const [ownMenuOpen, setOwnMenuOpen] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const deleteStatus = useDeleteStatus();
  const liked = useStatusLiked(status?.id, currentUserId);
  const toggleLike = useToggleStatusLike();
  const startThread = useStartThread();
  const sendMessage = useSendMessage();
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  // The reply bar is `position: absolute, bottom: 0` (it sits over a
  // full-bleed media background, not in normal flex flow), so it can't
  // be pushed up by a flex-flow spacer the way `KeyboardAvoidingScreen`
  // handles the message composer — it has to shift its own `bottom`
  // by the real keyboard height directly, same underlying measurement,
  // different application (2026-09-19, contacts/status punch-list
  // follow-up: "add the keyboard fix to the reply status feature").
  const keyboardHeight = useKeyboardHeight();

  if (!status) return null;

  const handleToggleLike = () => {
    if (!currentUserId) return;
    toggleLike.mutate({ statusId: status.id, userId: currentUserId, liked: !!liked.data });
  };

  // Confirm before deleting (there was no confirmation at all before this
  // punch-list item) — matches every other destructive action in this app
  // (block, remove group member, leave group, ...), all of which confirm
  // first.
  const handleDeleteStatus = () => {
    Alert.alert('Delete this status?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => deleteStatus.mutate({ id: status.id, media_path: status.media_path }),
      },
    ]);
  };

  // Reply opens (or continues) a real DM thread with the poster and sends
  // the typed text as a normal message there — the same paid-message path
  // every other conversation in this app goes through (docs/03-ECONOMY-
  // LEDGER.md §4), not a new billing concept invented for status replies.
  // Matches WhatsApp's own behavior of landing you in the chat after a
  // status reply, rather than a separate "status comments" surface.
  const handleSendReply = () => {
    const text = replyText.trim();
    if (!text || sendingReply) return;
    setSendingReply(true);
    startThread.mutate(group.poster.id, {
      onSuccess: (thread) => {
        sendMessage.mutate(
          { threadId: thread.thread_id, body: text },
          {
            onSuccess: () => {
              onClose();
              router.push(`/thread/${thread.thread_id}`);
            },
            onSettled: () => setSendingReply(false),
          },
        );
      },
      onError: () => setSendingReply(false),
    });
  };

  // Tapping the poster's name takes you straight to their chat (punch-list
  // item 4b's explicit spec: "takes them to their chat", not their
  // profile) — find-or-create via the same fn_start_thread every other
  // "go straight into a chat" entry point in this app already uses.
  const handleTapName = () => {
    if (openingChat) return;
    setOpeningChat(true);
    startThread.mutate(group.poster.id, {
      onSuccess: (thread) => {
        onClose();
        router.push(`/thread/${thread.thread_id}`);
      },
      onSettled: () => setOpeningChat(false),
    });
  };

  const template = status.text_style ? getStatusTextTemplate(status.text_style) : null;

  return (
    <View style={{ width, flex: 1, backgroundColor: template ? template.background : '#000' }}>
      <StoryBackground status={status} template={template} />

      {/* Rendered right after the background, not last — a later sibling
          sits on top for touch handling the same as it does visually, so
          this has to be *underneath* the header/controls/reply-bar below
          (real bug found and fixed while adding the reply bar, 2026-09-19:
          rendering this last, as it was before, would have put it above
          every one of those interactive elements, silently swallowing
          taps on the view-count/delete buttons and the new reply input
          alike). It still correctly handles every tap that isn't already
          captured by something rendered above it. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Pressable style={styles.tapZoneLeft} onPress={() => onAdvance(-1)} />
        <Pressable style={styles.tapZoneRight} onPress={() => onAdvance(1)} />
      </View>

      <View style={[styles.progressRow, { top: 50, paddingHorizontal: spacing.sm }]}>
        {group.statuses.map((s, i) => (
          <View key={s.id} style={styles.progressTrack}>
            {i < itemIndex ? (
              <View style={[styles.progressFill, { width: '100%' }]} />
            ) : i === itemIndex && isActive ? (
              <AnimatedProgressBar key={`${group.poster.id}-${itemIndex}`} />
            ) : null}
          </View>
        ))}
      </View>

      <View style={[styles.header, { paddingHorizontal: spacing.lg }]}>
        <Pressable
          onPress={isOwn ? undefined : handleTapName}
          disabled={isOwn}
          style={[styles.headerIdentity, { gap: spacing.sm }]}
        >
          <Avatar uri={group.poster.avatar_url} displayName={group.poster.display_name} size={32} />
          <View>
            <Text variant="bodyMedium" color="inverse">
              {group.poster.display_name ?? 'Someone'}
            </Text>
            <Text variant="caption" color="inverse" style={styles.headerTime}>
              {formatStatusAge(status.created_at)}
            </Text>
          </View>
        </Pressable>
        {isOwn ? (
          <Pressable onPress={() => setOwnMenuOpen(true)} hitSlop={12} style={{ marginRight: 20 }}>
            <Ionicons name="ellipsis-vertical" size={22} color="#fff" />
          </Pressable>
        ) : null}
        <Pressable onPress={onClose} hitSlop={12}>
          <Ionicons name="close" size={28} color="#fff" />
        </Pressable>
      </View>

      {isOwn ? (
        <View style={[styles.ownControls, { paddingHorizontal: spacing.lg, gap: spacing.lg }]}>
          <Pressable
            onPress={() => setShowViewCount((v) => !v)}
            style={styles.ownControlButton}
            hitSlop={8}
          >
            <Ionicons name="eye" size={20} color="#fff" />
            {showViewCount ? (
              <Text variant="caption" color="inverse" style={{ marginLeft: 6 }}>
                {viewCount.data ?? 0} views
              </Text>
            ) : null}
          </Pressable>
          <Pressable
            onPress={() => setLikersModalOpen(true)}
            style={styles.ownControlButton}
            hitSlop={8}
          >
            <Ionicons name="heart" size={20} color="#fff" />
            <Text variant="caption" color="inverse" style={{ marginLeft: 6 }}>
              {likers.data?.length ?? 0} likes
            </Text>
          </Pressable>
        </View>
      ) : (
        // Reply + like bar (punch-list item 4a, 2026-09-19) — only for
        // other people's statuses; liking/replying to your own doesn't
        // make sense, matching WhatsApp's own status viewer.
        <View
          style={[
            styles.replyBar,
            {
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.lg,
              gap: spacing.sm,
              bottom: keyboardHeight,
            },
          ]}
        >
          <TextInput
            value={replyText}
            onChangeText={setReplyText}
            onFocus={() => onReplyFocusChange(true)}
            onBlur={() => onReplyFocusChange(false)}
            placeholder="Reply..."
            placeholderTextColor="rgba(255,255,255,0.7)"
            style={styles.replyInput}
          />
          {replyText.trim() ? (
            <Pressable onPress={handleSendReply} disabled={sendingReply} hitSlop={8}>
              <Ionicons name="send" size={24} color="#fff" />
            </Pressable>
          ) : (
            <Pressable onPress={handleToggleLike} hitSlop={8}>
              <Ionicons
                name={liked.data ? 'heart' : 'heart-outline'}
                size={26}
                color={liked.data ? colors.brandPrimary : '#fff'}
              />
            </Pressable>
          )}
        </View>
      )}

      {isOwn ? (
        <>
          <ActionSheet
            visible={ownMenuOpen}
            onClose={() => setOwnMenuOpen(false)}
            actions={[{ label: 'Delete status', destructive: true, onPress: handleDeleteStatus }]}
          />
          <StatusLikersModal
            visible={likersModalOpen}
            onClose={() => setLikersModalOpen(false)}
            likers={likers.data ?? []}
            isLoading={likers.isLoading}
          />
        </>
      ) : null}
    </View>
  );
}

/** Animates 0% -> 100% over ITEM_DURATION_MS, matching the JS `setTimeout`
 * that actually drives auto-advance in the parent — purely visual, this
 * component's `key` (poster+item) is what "resets" it on every item
 * change, rather than manually resetting a shared value. */
function AnimatedProgressBar() {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(1, { duration: ITEM_DURATION_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return <Animated.View style={[styles.progressFill, style]} />;
}

function StoryBackground({
  status,
  template,
}: {
  status: StatusUpdate;
  template: ReturnType<typeof getStatusTextTemplate> | null;
}) {
  const { spacing } = useTheme();
  const { data: signedUrl } = useStatusMediaUrl(status.media_path);

  if (status.media_path) {
    return (
      <View style={styles.flex}>
        {signedUrl ? (
          <Image source={{ uri: signedUrl }} style={styles.flex} resizeMode="contain" />
        ) : null}
        {status.caption ? (
          <View style={[styles.mediaCaption, { padding: spacing.lg }]}>
            <Text variant="body" color="inverse">
              {status.caption}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={[styles.flex, styles.centered, { padding: spacing.xl }]}>
      <Text
        variant="display"
        style={{ color: template?.foreground ?? '#fff', textAlign: 'center' }}
      >
        {status.caption}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  progressRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    gap: 4,
    zIndex: 2,
  },
  progressTrack: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: '#fff' },
  header: {
    position: 'absolute',
    top: 64,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 2,
  },
  headerIdentity: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 12 },
  headerTime: { opacity: 0.8 },
  ownControls: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    flexDirection: 'row',
    zIndex: 2,
  },
  ownControlButton: { flexDirection: 'row', alignItems: 'center' },
  replyBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 2,
  },
  replyInput: {
    flex: 1,
    color: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 17,
  },
  tapZoneLeft: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '33%' },
  tapZoneRight: { position: 'absolute', right: 0, top: 0, bottom: 0, width: '67%' },
  mediaCaption: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
});
