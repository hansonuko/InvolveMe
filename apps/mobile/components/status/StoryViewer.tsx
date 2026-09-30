import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
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
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { ActionSheet } from '@/components/ui/ActionSheet';
import { Avatar } from '@/components/ui/Avatar';
import { useKeyboardHeight } from '@/components/ui/KeyboardAvoidingScreen';
import { StatusViewersModal } from '@/components/status/StatusViewersModal';
import { Text } from '@/components/ui/Text';
import { useSendMessage } from '@/lib/queries/messages';
import {
  useDeleteStatus,
  useMarkStatusViewed,
  useStatusLiked,
  useStatusMediaUrl,
  useStatusViewers,
  useToggleStatusLike,
  type StatusFeedGroup,
  type StatusUpdate,
} from '@/lib/queries/status';
import { useStartThread } from '@/lib/queries/threads';
import { formatStatusAge } from '@/lib/statusAge';
import { showAlert } from '@/lib/ui/alert';
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
  // Hold-to-pause (press and hold anywhere on the media to freeze it, WhatsApp's
  // own behavior for reading a longer text status or studying a photo) —
  // pauses both the auto-advance timer below and the progress bar's fill
  // animation; released back into normal ticking on release, same "don't
  // interrupt what the user is doing" instinct isReplyFocused already
  // applies for the reply input.
  const [isHeld, setIsHeld] = useState(false);
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
  // Remaining time for the *current* item, in ms — reset to the full
  // duration whenever the item itself changes, decremented by however long
  // the previous scheduling effect actually ran whenever pausing
  // (isReplyFocused/isHeld) preempts it. Read/written by the scheduling
  // effect below, not by React state, since neither its value nor its
  // start timestamp should ever trigger a re-render on their own.
  const remainingMsRef = useRef(ITEM_DURATION_MS);
  const startedAtRef = useRef(0);
  useEffect(() => {
    remainingMsRef.current = ITEM_DURATION_MS;
    startedAtRef.current = Date.now();
  }, [posterIndex, itemIndex]);

  // Schedules (or, while paused, just accounts for elapsed time against)
  // the current item's remaining duration — resuming from a hold or a
  // closed reply input picks up with whatever time was actually left,
  // rather than restarting the full 6s and drifting out of sync with the
  // progress bar's own resume logic in AnimatedProgressBar below.
  useEffect(() => {
    if (!activeStatus) return;
    if (isReplyFocused || isHeld) {
      remainingMsRef.current -= Date.now() - startedAtRef.current;
      return;
    }
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => advance(1), Math.max(remainingMsRef.current, 0));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posterIndex, itemIndex, isReplyFocused, isHeld]);

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
            isHeld={index === posterIndex && isHeld}
            onHoldChange={setIsHeld}
          />
        )}
      />
    </Modal>
  );
}

// A held-then-released touch shouldn't also advance the story once
// released — only a touch shorter than this counts as a real tap. Matches
// the feel of a deliberate "hold to pause" vs. a normal quick tap.
const HOLD_THRESHOLD_MS = 250;

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
  isHeld,
  onHoldChange,
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
  isHeld: boolean;
  onHoldChange: (held: boolean) => void;
}) {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const status = group.statuses[itemIndex];
  const viewers = useStatusViewers(isOwn && isActive ? status?.id : undefined);
  const [viewersModalOpen, setViewersModalOpen] = useState(false);
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
  const pressStartRef = useRef(0);

  if (!status) return null;

  // Pause immediately on touch-down; on release, only actually advance if
  // it was a genuine quick tap (per HOLD_THRESHOLD_MS) — a held-then-
  // released touch just resumes the current item where it left off,
  // matching WhatsApp: holding to read never skips you to the next status
  // the moment you let go.
  const handlePressIn = () => {
    pressStartRef.current = Date.now();
    onHoldChange(true);
  };
  const handlePressOut = (direction: 1 | -1) => {
    const heldMs = Date.now() - pressStartRef.current;
    onHoldChange(false);
    if (heldMs < HOLD_THRESHOLD_MS) {
      onAdvance(direction);
    }
  };

  const handleToggleLike = () => {
    if (!currentUserId) return;
    toggleLike.mutate({ statusId: status.id, userId: currentUserId, liked: !!liked.data });
  };

  // Confirm before deleting (there was no confirmation at all before this
  // punch-list item) — matches every other destructive action in this app
  // (block, remove group member, leave group, ...), all of which confirm
  // first.
  const handleDeleteStatus = () => {
    showAlert('Delete this status?', 'This cannot be undone.', [
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
  //
  // Real bug fixed here: neither mutation's failure was ever surfaced —
  // insufficient credit, a content-moderation block, a blocked thread, or
  // any other rejection just silently reset `sendingReply` with no
  // indication anything went wrong, which reads exactly like "I tap send
  // and it gets stuck, nothing happens." Every failure now shows a real
  // message, matching how every other send failure in this app is
  // surfaced (compare thread/[id].tsx's own error handling).
  const handleSendReply = () => {
    const text = replyText.trim();
    if (!text || sendingReply) return;
    setSendingReply(true);
    // Keep auto-advance paused for the whole round trip, not just while the
    // input has native focus — tapping the send icon blurs the TextInput
    // immediately, which would otherwise resume the auto-advance timer
    // (and potentially close/advance past this status) while the request
    // is still in flight.
    onReplyFocusChange(true);

    const finish = () => {
      setSendingReply(false);
      onReplyFocusChange(false);
    };

    startThread.mutate(group.poster.id, {
      onSuccess: (thread) => {
        sendMessage.mutate(
          // docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §B1 —
          // replyToStatusId is always passed on a real status reply;
          // fn_send_message is the actual authority on whether this turns
          // out free (only the sender's first-ever message in this
          // thread, no media, a real/unexpired/visible status). This is
          // just informational context for display, never a client-side
          // "this send is free" assumption.
          { threadId: thread.thread_id, body: text, replyToStatusId: status.id },
          {
            onSuccess: () => {
              onClose();
              router.push(`/thread/${thread.thread_id}`);
            },
            onError: (error) => {
              showAlert(
                'Could not send reply',
                error.code === 'insufficient_credit'
                  ? 'You need more chat credit to reply to this status.'
                  : error.code === 'invalid_status_reply_target'
                    ? 'This status is no longer available to reply to.'
                    : error.message,
              );
            },
            onSettled: finish,
          },
        );
      },
      onError: (error) => {
        finish();
        showAlert('Could not send reply', error.message);
      },
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
        <Pressable
          style={styles.tapZoneLeft}
          onPressIn={handlePressIn}
          onPressOut={() => handlePressOut(-1)}
        />
        <Pressable
          style={styles.tapZoneRight}
          onPressIn={handlePressIn}
          onPressOut={() => handlePressOut(1)}
        />
      </View>

      <View style={[styles.progressRow, { top: 50, paddingHorizontal: spacing.sm }]}>
        {group.statuses.map((s, i) => (
          <View key={s.id} style={styles.progressTrack}>
            {i < itemIndex ? (
              <View style={[styles.progressFill, { width: '100%' }]} />
            ) : i === itemIndex && isActive ? (
              <AnimatedProgressBar key={`${group.poster.id}-${itemIndex}`} isPaused={isHeld} />
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
          {/* One combined "who viewed this" entry point (WhatsApp's own
           * shape) — no separate heart/likers button; a viewer who also
           * liked shows a small heart inline in the list itself
           * (StatusViewersModal), not as its own surface. */}
          <Pressable
            onPress={() => setViewersModalOpen(true)}
            style={styles.ownControlButton}
            hitSlop={8}
          >
            <Ionicons name="eye" size={20} color="#fff" />
            <Text variant="caption" color="inverse" style={{ marginLeft: 6 }}>
              {viewers.data?.length ?? 0} views
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
          <StatusViewersModal
            visible={viewersModalOpen}
            onClose={() => setViewersModalOpen(false)}
            viewers={viewers.data ?? []}
            isLoading={viewers.isLoading}
          />
        </>
      ) : null}
    </View>
  );
}

/** Animates 0% -> 100% over ITEM_DURATION_MS, matching the JS `setTimeout`
 * that actually drives auto-advance in the parent — purely visual, this
 * component's `key` (poster+item) is what "resets" it on every item
 * change, rather than manually resetting a shared value.
 *
 * `isPaused` freezes the fill exactly where it is (hold-to-pause) and
 * resumes it from there rather than restarting — `progress.value` already
 * holds the live interpolated value at the instant `cancelAnimation` stops
 * it, so no separate elapsed-time bookkeeping is needed here the way the
 * parent's JS-side `setTimeout` needs its own (they're two independent
 * clocks aimed at the same wall-clock deadline, not synchronized to each
 * other directly). */
function AnimatedProgressBar({ isPaused }: { isPaused: boolean }) {
  const progress = useSharedValue(0);
  // Wall-clock bookkeeping, same shape as the parent's own remaining-time
  // tracking — deliberately not read back from `progress.value` (mixing a
  // read and a later write of the same shared value across renders trips
  // the React Compiler's immutability check, since it can't see into
  // Reanimated's own mutation contract).
  const startedAtRef = useRef(0);
  const remainingMsRef = useRef(ITEM_DURATION_MS);

  useEffect(() => {
    startedAtRef.current = Date.now();
    progress.value = withTiming(1, { duration: ITEM_DURATION_MS });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPaused) {
      cancelAnimation(progress);
      remainingMsRef.current -= Date.now() - startedAtRef.current;
      return;
    }
    startedAtRef.current = Date.now();
    if (remainingMsRef.current > 0) {
      // react-hooks/immutability flags this as mutating `progress` across
      // two different effects — a real rule for plain React refs/state,
      // but a false positive for a Reanimated shared value, whose entire
      // contract is that `.value` can be written from anywhere (worklets,
      // multiple effects, event handlers) by design; the compiler doesn't
      // model that exemption.
      // eslint-disable-next-line react-hooks/immutability
      progress.value = withTiming(1, { duration: remainingMsRef.current });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPaused]);

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
  // Lifted well clear of the bottom-edge controls (the reply bar for
  // someone else's status, the view/likes row for your own) rather than
  // sitting flush at `bottom: 0` — matches WhatsApp's own photo-status
  // caption position, and stops the two from ever visually colliding.
  mediaCaption: {
    position: 'absolute',
    bottom: 120,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
});
