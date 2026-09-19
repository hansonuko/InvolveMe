import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { AppHeader } from '@/components/ui/AppHeader';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { StatusComposer } from '@/components/status/StatusComposer';
import { StoryViewer } from '@/components/status/StoryViewer';
import { useSession } from '@/lib/hooks/useSession';
import { useProfile } from '@/lib/queries/profile';
import {
  type StatusFeedGroup,
  type StatusUpdate,
  useMyStatusUpdates,
  useStatusFeed,
  useStatusMediaUrl,
} from '@/lib/queries/status';
import { formatStatusAge } from '@/lib/statusAge';
import { getStatusTextTemplate } from '@/lib/statusTextTemplates';
import { useTheme } from '@/theme';

// Sized to match the real WhatsApp Updates screen's own preview-card
// carousel (punch-list item 1, 2026-09-19's explicit "carousels should be
// the size used on whatsapp update screen" ask) — a tall portrait card,
// not a square/small thumbnail.
const CARD_WIDTH = 104;
const CARD_HEIGHT = 168;
const CARD_AVATAR_SIZE = 32;
const OWN_CIRCLE_SIZE = 72;

/** The actual preview surface inside a carousel card — a signed-URL photo
 * thumbnail, or the poster's chosen text-status background/caption. Split
 * out from PreviewCard so the `useStatusMediaUrl` hook only ever fires
 * for the one status actually being previewed (a card's most recent
 * status), never for every status a poster has. */
function CardPreviewContent({ status }: { status: StatusUpdate }) {
  const { data: signedUrl } = useStatusMediaUrl(status.media_path);
  const template = status.text_style ? getStatusTextTemplate(status.text_style) : null;

  if (status.media_path) {
    return signedUrl ? (
      <Image source={{ uri: signedUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
    ) : (
      <View style={[StyleSheet.absoluteFill, styles.cardLoading]} />
    );
  }

  return (
    <View
      style={[
        StyleSheet.absoluteFill,
        styles.cardTextPreview,
        { backgroundColor: template?.background ?? '#5F1B31' },
      ]}
    >
      <Text
        variant="caption"
        numberOfLines={5}
        style={{ color: template?.foreground ?? '#fff', textAlign: 'center', fontWeight: '600' }}
      >
        {status.caption}
      </Text>
    </View>
  );
}

/** One rectangular card in the top carousel — a small ring avatar
 * overlaid top-left (unseen = deep-wine/gold ring, seen = gray, same
 * `Avatar` ring convention every other status UI in this app already
 * uses) and the poster's name on a bottom scrim strip. `onAddPress`, when
 * given, renders an extra "+" badge — only the owner's own card (once
 * they already have an active status) gets one, so tapping it can open
 * the composer directly instead of the viewer the rest of the card opens. */
function PreviewCard({
  group,
  onPress,
  onAddPress,
}: {
  group: StatusFeedGroup;
  onPress: () => void;
  onAddPress?: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const latest = group.statuses[0];
  if (!latest) return null;

  return (
    <Pressable
      onPress={onPress}
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        marginRight: spacing.sm,
        borderRadius: radius.card,
        overflow: 'hidden',
        backgroundColor: colors.bgSurfaceAlt,
      }}
    >
      <CardPreviewContent status={latest} />

      <View style={[styles.cardAvatarWrap, { top: spacing.sm, left: spacing.sm }]}>
        <Avatar
          uri={group.poster.avatar_url}
          displayName={group.poster.display_name}
          size={CARD_AVATAR_SIZE}
          ringVariant={group.hasUnseen ? 'unseen' : 'seen'}
        />
      </View>

      {onAddPress ? (
        <Pressable
          onPress={onAddPress}
          hitSlop={8}
          style={[
            styles.cardAddBadge,
            { backgroundColor: colors.accentCredit, borderColor: colors.bgCanvas },
          ]}
        >
          <Ionicons name="add" size={14} color={colors.textPrimary} />
        </Pressable>
      ) : null}

      <View style={[styles.cardNameScrim, { padding: spacing.xs }]}>
        <Text variant="caption" color="inverse" numberOfLines={1} style={{ fontWeight: '600' }}>
          {group.poster.display_name ?? 'Someone'}
        </Text>
      </View>
    </Pressable>
  );
}

/** First carousel slot when the owner has no active status yet — a plain
 * circle avatar with a "+" badge and a "Post Status" label underneath,
 * matching the carousel's own row height so it lines up with the
 * rectangular cards next to it. Punch-list item 1's explicit spec: tapping
 * opens the composer directly, not a viewer — there's nothing to view. */
function OwnEmptySlot({
  avatarUrl,
  displayName,
  onPress,
}: {
  avatarUrl: string | null | undefined;
  displayName: string | null | undefined;
  onPress: () => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        marginRight: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <View>
        <Avatar uri={avatarUrl} displayName={displayName} size={OWN_CIRCLE_SIZE} />
        <View
          style={[
            styles.ownPlusBadge,
            { backgroundColor: colors.brandPrimary, borderColor: colors.bgCanvas },
          ]}
        >
          <Ionicons name="add" size={16} color={colors.textInverse} />
        </View>
      </View>
      <Text
        variant="caption"
        color="secondary"
        numberOfLines={1}
        style={{ marginTop: spacing.xs, fontWeight: '600' }}
      >
        Post Status
      </Text>
    </Pressable>
  );
}

/** Row in the "Viewed updates" section below the carousel — a standard
 * full-width contact row (gray-ring avatar, name, relative time), not
 * another horizontal carousel — item 1's own spec calls this out as "a
 * scrollable row" distinct from the carousel above it, matching WhatsApp's
 * own Viewed-updates list shape. */
function ViewedRow({ group, onPress }: { group: StatusFeedGroup; onPress: () => void }) {
  const { spacing } = useTheme();
  const latest = group.statuses[0];
  return (
    <Pressable
      onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm }}
    >
      <Avatar
        uri={group.poster.avatar_url}
        displayName={group.poster.display_name}
        size={48}
        ringVariant="seen"
      />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text variant="bodyMedium">{group.poster.display_name ?? 'Someone'}</Text>
        {latest ? (
          <Text variant="caption" color="tertiary">
            Updated {formatStatusAge(latest.created_at)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Status/Updates tab — full WhatsApp-Updates-screen parity rebuild
 * (punch-list item 1, 2026-09-19). Previously a horizontal ring row above
 * a plain vertical list of the owner's own posts with a trash icon per
 * row; replaced with: a horizontal preview-card carousel (unseen statuses
 * — real photo/text-status thumbnails, not just avatar rings) whose first
 * slot is the owner's own post-status/own-status entry, a "Viewed
 * updates" vertical list below it for already-seen posters, and a
 * floating camera+pen compose button in place of the old full-width
 * "New status update" button. Full-screen viewing (tap-to-open, 6s
 * auto-advance with a top progress bar, swipe-between-posters) was
 * already built correctly in an earlier session (StoryViewer, Batch F) —
 * untouched here except for a small header-parity addition (see that
 * file), since it already matched this item's own "tiny white countdown
 * bar... auto-advancing to the next unviewed status" spec.
 *
 * Deleting an individual status remains available from inside the viewer
 * itself (its own trash icon on an owner's status) rather than a separate
 * management list — WhatsApp has no such list either, and item 1's own
 * ask was to replace the "boring manual list," not preserve it alongside
 * the new carousel.
 */
export default function StatusScreen() {
  const { colors, spacing } = useTheme();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: profile } = useProfile(userId);
  const { data: myStatuses } = useMyStatusUpdates(userId);
  const { data: feed } = useStatusFeed(userId);
  const [composerVisible, setComposerVisible] = useState(false);

  // Frozen snapshot the moment a viewer opens — see useStatusFeed's own
  // comment on why this matters: it re-sorts live the instant a status
  // gets marked viewed, and StoryViewer tracks its position as a plain
  // array index. Without freezing, marking the currently-open poster's
  // status viewed mid-session would reorder the array out from under it,
  // silently swapping in whoever else now sits at that index — the exact
  // bug the original RecentUpdatesRow's own snapshot already guarded
  // against, reused here for all three sub-feeds (unseen/seen/own).
  const [openViewer, setOpenViewer] = useState<{ feed: StatusFeedGroup[]; index: number } | null>(
    null,
  );

  const unseenGroups = (feed ?? []).filter((g) => g.hasUnseen);
  const seenGroups = (feed ?? []).filter((g) => !g.hasUnseen);

  const ownGroup: StatusFeedGroup | null =
    userId && myStatuses && myStatuses.length > 0
      ? {
          poster: {
            id: userId,
            display_name: profile?.display_name ?? null,
            avatar_url: profile?.avatar_url ?? null,
          },
          statuses: myStatuses,
          hasUnseen: false,
        }
      : null;

  const carouselHeader = (
    <View style={{ marginBottom: spacing.lg }}>
      <FlatList
        data={unseenGroups}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(g) => g.poster.id}
        ListHeaderComponent={
          ownGroup ? (
            <PreviewCard
              group={ownGroup}
              onPress={() => setOpenViewer({ feed: [ownGroup], index: 0 })}
              onAddPress={() => setComposerVisible(true)}
            />
          ) : (
            <OwnEmptySlot
              avatarUrl={profile?.avatar_url}
              displayName={profile?.display_name}
              onPress={() => setComposerVisible(true)}
            />
          )
        }
        renderItem={({ item, index }) => (
          <PreviewCard group={item} onPress={() => setOpenViewer({ feed: unseenGroups, index })} />
        )}
      />

      {seenGroups.length > 0 ? (
        <Text variant="title" style={{ marginTop: spacing.lg }}>
          Viewed updates
        </Text>
      ) : unseenGroups.length === 0 ? (
        <Text variant="body" color="tertiary" style={{ marginTop: spacing.lg }}>
          No status updates from your contacts yet.
        </Text>
      ) : null}
    </View>
  );

  return (
    <Screen style={{ paddingHorizontal: 0 }}>
      <AppHeader title="Status" />

      <View style={{ flex: 1, paddingHorizontal: spacing.lg }}>
        <FlatList
          data={seenGroups}
          keyExtractor={(g) => g.poster.id}
          ListHeaderComponent={carouselHeader}
          renderItem={({ item, index }) => (
            <ViewedRow group={item} onPress={() => setOpenViewer({ feed: seenGroups, index })} />
          )}
        />
      </View>

      {/* Floating compose button — a single camera-primary button with a
          small pen badge (punch-list item 1's explicit "camera + pen sign"
          spec), replacing the old full-width "New status update" button. */}
      <Pressable
        onPress={() => setComposerVisible(true)}
        style={[
          styles.fab,
          { backgroundColor: colors.brandPrimary, bottom: spacing.xxl, right: spacing.lg },
        ]}
      >
        <Ionicons name="camera" size={22} color={colors.textInverse} />
        <View
          style={[
            styles.fabPenBadge,
            { backgroundColor: colors.accentCredit, borderColor: colors.bgCanvas },
          ]}
        >
          <Ionicons name="pencil" size={11} color={colors.textPrimary} />
        </View>
      </Pressable>

      {openViewer ? (
        <StoryViewer
          feed={openViewer.feed}
          initialPosterIndex={openViewer.index}
          currentUserId={userId}
          onClose={() => setOpenViewer(null)}
        />
      ) : null}

      <StatusComposer visible={composerVisible} onClose={() => setComposerVisible(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardAvatarWrap: { position: 'absolute', zIndex: 2 },
  cardAddBadge: {
    position: 'absolute',
    bottom: 34,
    right: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  cardNameScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  cardTextPreview: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  cardLoading: { backgroundColor: 'rgba(0,0,0,0.08)' },
  ownPlusBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fab: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabPenBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
