import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Modal,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Text } from '@/components/ui/Text';
import {
  useDeleteStatus,
  useMarkStatusViewed,
  useStatusMediaUrl,
  useStatusViewCount,
  type StatusFeedGroup,
  type StatusUpdate,
} from '@/lib/queries/status';
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

  // 6s auto-advance, reset on every item/poster change.
  useEffect(() => {
    if (!activeStatus) return;
    const timer = setTimeout(() => advance(1), ITEM_DURATION_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posterIndex, itemIndex]);

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
            onAdvance={advance}
            onClose={onClose}
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
  onAdvance,
  onClose,
}: {
  group: StatusFeedGroup;
  width: number;
  itemIndex: number;
  isActive: boolean;
  isOwn: boolean;
  onAdvance: (direction: 1 | -1) => void;
  onClose: () => void;
}) {
  const { spacing } = useTheme();
  const status = group.statuses[itemIndex];
  const viewCount = useStatusViewCount(isOwn && isActive ? status?.id : undefined);
  const [showViewCount, setShowViewCount] = useState(false);
  const deleteStatus = useDeleteStatus();

  if (!status) return null;

  const template = status.text_style ? getStatusTextTemplate(status.text_style) : null;

  return (
    <View style={{ width, flex: 1, backgroundColor: template ? template.background : '#000' }}>
      <StoryBackground status={status} template={template} />

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
        <Text variant="bodyMedium" color="inverse">
          {group.poster.display_name ?? 'Someone'}
        </Text>
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
            onPress={() => deleteStatus.mutate({ id: status.id, media_path: status.media_path })}
            style={styles.ownControlButton}
            hitSlop={8}
          >
            <Ionicons name="trash" size={20} color="#fff" />
          </Pressable>
        </View>
      ) : null}

      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        <Pressable style={styles.tapZoneLeft} onPress={() => onAdvance(-1)} />
        <Pressable style={styles.tapZoneRight} onPress={() => onAdvance(1)} />
      </View>
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
  ownControls: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    flexDirection: 'row',
    zIndex: 2,
  },
  ownControlButton: { flexDirection: 'row', alignItems: 'center' },
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
