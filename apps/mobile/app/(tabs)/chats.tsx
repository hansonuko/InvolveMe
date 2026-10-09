import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { ActionSheet } from '@/components/ui/ActionSheet';
import { AppHeader } from '@/components/ui/AppHeader';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { MemberSearchList } from '@/components/groups/MemberSearchList';
import { StoryViewer } from '@/components/status/StoryViewer';
import { type DeviceContact, useDeviceContacts, usePhoneContactNames } from '@/lib/contacts';
import { shareInvite } from '@/lib/invite';
import { type MatchedContactUser, useFindUsersByPhones } from '@/lib/queries/contacts';
import { type StatusFeedGroup, useStatusFeed } from '@/lib/queries/status';
import { type ThreadWithPartner, useStartThread, useThreads } from '@/lib/queries/threads';
import { useSession } from '@/lib/hooks/useSession';
import { useIsWideWeb } from '@/lib/hooks/useIsWideWeb';
import { toE164NigerianPhone } from '@/lib/phone';
import { useTheme } from '@/theme';

// Was pushed to 92dp on an earlier "bigger chat-list avatars" ask, which
// overshot into looking oversized/unbalanced against the row's text —
// pulled back to 52dp on 2026-09-18, matching the size this app's own
// other list-row avatars already use (NewChatModal's found-user row,
// ContactRow below) rather than inventing a fourth bespoke value, and in
// line with the ~52-56dp row-avatar size WhatsApp and similar chat apps
// use.
const AVATAR_SIZE = 52;

/** Same-day -> "3:00 PM", otherwise a short date — enough to match the
 * mockup's per-row timestamp without pulling in a date library for it. */
function formatThreadTimestamp(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ThreadRow({
  thread,
  onPress,
  statusGroup,
  onViewStatus,
  contactName,
}: {
  thread: ThreadWithPartner;
  onPress: () => void;
  /** This partner's active status, if any — undefined means no active
   * status at all (ring hidden). Drives both the ring color (punch-list
   * item 2, 2026-09-19: deep-wine/gold while `hasUnseen`, gray once
   * every status in it has been viewed) and the avatar tap behavior. */
  statusGroup?: StatusFeedGroup;
  onViewStatus?: (group: StatusFeedGroup) => void;
  /** Device-contact name if saved, else the raw phone number, else
   * "Unnamed" — resolved by the parent (punch-list item 1, 2026-09-19).
   * Never the partner's own `display_name` as an unsaved-contact
   * fallback; see `resolveContactName` in ChatsScreen for why. */
  contactName: string;
}) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const [sheetVisible, setSheetVisible] = useState(false);

  // Tapping the avatar goes straight to viewing an unseen status (the
  // whole point of the ring is "something new to see") — once every
  // status in the group has already been viewed, the ring turns gray and
  // the avatar tap reverts to the pre-existing default (the
  // Message/Profile action sheet), per the user's own explicit spec
  // rather than always opening the viewer the way some reference apps do.
  const handleAvatarPress = () => {
    if (statusGroup?.hasUnseen && onViewStatus) {
      onViewStatus(statusGroup);
    } else {
      setSheetVisible(true);
    }
  };

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          paddingVertical: spacing.md,
          borderRadius: radius.card,
          backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
        },
      ]}
    >
      <Pressable onPress={handleAvatarPress} hitSlop={4}>
        <Avatar
          uri={thread.partner.avatar_url}
          displayName={contactName}
          size={AVATAR_SIZE}
          ringVariant={statusGroup ? (statusGroup.hasUnseen ? 'unseen' : 'seen') : 'none'}
        />
      </Pressable>
      <ActionSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        title={contactName}
        actions={[
          { label: 'Message', onPress },
          {
            label: 'Profile',
            onPress: () =>
              router.push({
                pathname: '/profile/[id]',
                params: { id: thread.partner.id, threadId: thread.id },
              }),
          },
        ]}
      />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text variant="bodyMedium">{contactName}</Text>
        {thread.blocked_by ? (
          <Text variant="caption" color="danger">
            Blocked
          </Text>
        ) : thread.last_message_body ? (
          <Text variant="caption" color="tertiary" numberOfLines={1}>
            {thread.last_message_body}
          </Text>
        ) : null}
      </View>

      {/* Timestamp above, unread-count pill below — same right-column
          layout the wine-rebrand mockup showed, per
          docs/00-SESSION-HANDOFF.md's unread-tracking section. The pill
          only renders once there's a real count (thread_unread_counts,
          migration 20260914080000_thread_read_cursor.sql) — never a
          fabricated number. */}
      <View style={[styles.rowEnd, { marginLeft: spacing.sm, gap: spacing.xs }]}>
        {thread.last_message_at ? (
          <Text variant="caption" color="tertiary">
            {formatThreadTimestamp(thread.last_message_at)}
          </Text>
        ) : null}
        {thread.unread_count > 0 ? (
          <View
            style={[
              styles.unreadBadge,
              {
                backgroundColor: colors.badgeBg,
                borderRadius: radius.pill,
                paddingHorizontal: spacing.xs,
              },
            ]}
          >
            <Text variant="caption" color="badge">
              {thread.unread_count > 99 ? '99+' : thread.unread_count}
            </Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

type ChatsSubTab = 'chats' | 'contacts';

const SUB_TABS: { key: ChatsSubTab; label: string }[] = [
  { key: 'chats', label: 'Chats' },
  { key: 'contacts', label: 'Contacts' },
];

/** Chats/Contacts segmented row under the header. Groups moved to its own
 * top-level tab (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A5,
 * (tabs)/groups.tsx) — no longer a sub-tab here. "Contacts"
 * is real as of docs/10-UX-REFINEMENT-BACKLOG.md Batch C1 (see
 * ContactsList below).
 *
 * **2026-09-14:** each tab is now an equal-width flex column spanning the
 * full screen width (rather than left-clustered with a fixed gap), per
 * an explicit "spread and space them equally to fit 100% width, same
 * column width" ask — the three labels/indicators now land at exactly
 * 1/3, 2/3, and the far edge regardless of screen width. */
function ChatsSubHeader({
  active,
  onChange,
}: {
  active: ChatsSubTab;
  onChange: (tab: ChatsSubTab) => void;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={styles.subHeaderRow}>
      {SUB_TABS.map((tab) => (
        <Pressable
          key={tab.key}
          onPress={() => onChange(tab.key)}
          hitSlop={8}
          style={styles.subHeaderCol}
        >
          <View style={{ gap: spacing.xs, alignItems: 'center' }}>
            <Text variant="bodyMedium" color={active === tab.key ? 'secondary' : 'tertiary'}>
              {tab.label}
            </Text>
            <View
              style={[
                styles.subHeaderIndicator,
                { backgroundColor: active === tab.key ? colors.textSecondary : 'transparent' },
              ]}
            />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/** New-chat flow: phone -> lookup -> tap the found user to go straight
 * into their chat (start-thread resolves/creates it with no message
 * required — see lib/queries/threads.ts's useStartThread). A plain Modal,
 * not a bottom-sheet library — no such dependency exists in this app yet
 * and one isn't worth adding for this ("stay lite" per CLAUDE.md). */
/**
 * docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A4 — replaces the old
 * phone-number-only "type the full number, tap Look up" flow with the
 * same search-as-you-type widget the group member picker already uses
 * (`MemberSearchList`): search by device-contact name, or a phone number
 * even when it isn't saved as a device contact at all (its own parallel
 * exact-match `find-user-by-phone` call, gated on the typed digits
 * actually looking like a complete number — never a partial/prefix
 * server search, which would be a real phone-enumeration surface this
 * app has never had). One shared widget, not a second search
 * implementation — `ContactsList` below is a different, sectioned
 * "browse your whole phonebook" surface and stays as-is; this is
 * specifically "find one person to start a chat with," the same job
 * `MemberSearchList` already does for "find one person to add to a
 * group."
 */
function NewChatModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { spacing } = useTheme();
  const router = useRouter();
  const startThread = useStartThread();
  // Bumped on close so MemberSearchList clears its own search box/cached
  // device-contacts read for the next time this modal opens — same
  // pattern NewGroupModal's own resetToken already establishes.
  const [resetToken, setResetToken] = useState(0);

  const handleClose = () => {
    setResetToken((k) => k + 1);
    startThread.reset();
    onClose();
  };

  const handleSelect = (user: MatchedContactUser) => {
    startThread.mutate(user.id, {
      onSuccess: (data) => {
        handleClose();
        router.push(`/thread/${data.thread_id}`);
      },
    });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <KeyboardAvoidingScreen>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text variant="title">New chat</Text>
            <Pressable onPress={handleClose} hitSlop={12}>
              <Text variant="body" color="secondary">
                Close
              </Text>
            </Pressable>
          </View>

          {startThread.isError ? (
            <Text variant="caption" color="danger" style={{ marginTop: spacing.md }}>
              {startThread.error.message}
            </Text>
          ) : null}

          <View style={{ gap: spacing.md, marginTop: spacing.xl, flex: 1 }}>
            <MemberSearchList
              key={resetToken}
              visible={visible}
              excludeUserIds={new Set()}
              onSelect={handleSelect}
            />
          </View>
        </KeyboardAvoidingScreen>
      </Screen>
    </Modal>
  );
}

interface ContactsSection {
  title: 'On InvolveMe' | 'Invite';
  data: { contact: DeviceContact; user: MatchedContactUser | null }[];
}

function ContactRow({
  contact,
  user,
  onPress,
  statusGroup,
}: {
  contact: DeviceContact;
  user: MatchedContactUser | null;
  onPress: () => void;
  /** Visual only here (punch-list item 2's "app wide where found") — this
   * row's own tap already does one thing (open the chat, or share an
   * invite) depending on `user`, unlike ThreadRow's separate avatar-tap
   * target, so viewing a status from here isn't wired in to avoid
   * splitting that existing single-tap behavior into two zones for a
   * screen the user didn't explicitly ask to change. */
  statusGroup?: StatusFeedGroup;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          paddingVertical: spacing.md,
          backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
        },
      ]}
    >
      <Avatar
        uri={user?.avatar_url ?? null}
        displayName={contact.name ?? user?.display_name ?? null}
        size={52}
        ringVariant={statusGroup ? (statusGroup.hasUnseen ? 'unseen' : 'seen') : 'none'}
      />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text variant="bodyMedium">{contact.name ?? user?.display_name ?? 'Unnamed'}</Text>
        <Text variant="caption" color="tertiary">
          {user ? 'On InvolveMe' : 'Invite to InvolveMe'}
        </Text>
      </View>
    </Pressable>
  );
}

/** Device-contacts sync (docs/10-UX-REFINEMENT-BACKLOG.md Batch C1):
 * permission requested on first mount of this component (i.e. first time
 * the Contacts sub-tab is actually rendered, never at app launch), then
 * the whole phonebook is normalized and checked against InvolveMe's user
 * base in one batch call. Split into two sections — matched contacts tap
 * straight into a chat (reusing useStartThread, same as NewChatModal
 * above); unmatched contacts get the same generic Share.share invite
 * Settings already uses, per-row rather than a single bulk share (a share
 * sheet is inherently a one-recipient-at-a-time interaction on both
 * platforms). A `SectionList` (built into react-native, no new dependency)
 * rather than two separate FlatLists, so long lists still virtualize.
 *
 * Search + alphabetical order (punch-list item 3, 2026-09-19): both
 * sections sort by display name (`localeCompare`, not a raw string `<`,
 * so accented/non-ASCII names still land in the right place) and the
 * search box filters both by the same display name — matching the
 * `chats` sub-tab's own search bar shape/placement (own local state, a
 * non-sticky `ListHeaderComponent` that scrolls with the list) rather
 * than inventing a second search pattern in this same file. */
function ContactsList() {
  const router = useRouter();
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const { status, error, sync } = useDeviceContacts();
  const findUsers = useFindUsersByPhones();
  const startThread = useStartThread();
  // Same queryKey as ChatsScreen's own useStatusFeed call — TanStack Query
  // dedupes this to the shared cache, not a second network round-trip.
  const { data: statusFeed } = useStatusFeed(session?.user.id);
  const statusGroupByPosterId = new Map((statusFeed ?? []).map((g) => [g.poster.id, g]));
  const [contacts, setContacts] = useState<DeviceContact[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const deviceContacts = await sync();
      if (cancelled || deviceContacts.length === 0) return;
      setContacts(deviceContacts);

      const allPhones = [
        ...new Set(deviceContacts.flatMap((c) => c.phones.map(toE164NigerianPhone))),
      ];
      findUsers.mutate(allPhones);
    })();
    return () => {
      cancelled = true;
    };
    // Runs once, on this component's own mount (i.e. the first time the
    // Contacts sub-tab is switched to) — not on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleOpenChat = (user: MatchedContactUser) => {
    startThread.mutate(user.id, {
      onSuccess: (data) => router.push(`/thread/${data.thread_id}`),
    });
  };

  if (status === 'denied') {
    return (
      <View style={styles.empty}>
        <Text
          variant="body"
          color="tertiary"
          style={{ textAlign: 'center', marginBottom: spacing.md }}
        >
          Allow contacts access to see which of your contacts are already on InvolveMe.
        </Text>
        <Button label="Open settings" onPress={() => void Linking.openSettings()} />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.empty}>
        <Text variant="body" color="danger">
          {error}
        </Text>
      </View>
    );
  }

  if (status === 'idle' || status === 'requesting' || status === 'loading' || findUsers.isPending) {
    return (
      <View style={styles.empty}>
        <Text variant="body" color="tertiary">
          {status === 'requesting' ? 'Requesting contacts access…' : 'Loading contacts…'}
        </Text>
      </View>
    );
  }

  const matchByPhone = new Map((findUsers.data?.matches ?? []).map((m) => [m.phone, m] as const));

  const nameOf = (c: DeviceContact, u: MatchedContactUser | null) =>
    c.name ?? u?.display_name ?? '';
  const byName = (
    a: { contact: DeviceContact; user: MatchedContactUser | null },
    b: { contact: DeviceContact; user: MatchedContactUser | null },
  ) => nameOf(a.contact, a.user).localeCompare(nameOf(b.contact, b.user));

  const query = search.trim().toLowerCase();
  const onInvolveMe: { contact: DeviceContact; user: MatchedContactUser | null }[] = [];
  const toInvite: { contact: DeviceContact; user: MatchedContactUser | null }[] = [];
  for (const c of contacts) {
    const match = c.phones
      .map((p) => matchByPhone.get(toE164NigerianPhone(p).replace(/^\+/, '')))
      .find((m): m is MatchedContactUser => !!m);
    if (
      query &&
      !nameOf(c, match ?? null)
        .toLowerCase()
        .includes(query)
    )
      continue;
    (match ? onInvolveMe : toInvite).push({ contact: c, user: match ?? null });
  }
  onInvolveMe.sort(byName);
  toInvite.sort(byName);

  const sections: ContactsSection[] = [
    ...(onInvolveMe.length ? [{ title: 'On InvolveMe' as const, data: onInvolveMe }] : []),
    ...(toInvite.length ? [{ title: 'Invite' as const, data: toInvite }] : []),
  ];

  // Search box always renders once there's a real contact list to search —
  // even when the current query has zeroed out both sections, so the user
  // can see/clear what they typed instead of the box vanishing along with
  // the empty result (same reasoning the `chats` sub-tab's own search bar
  // follows: it's a ListHeaderComponent, not conditional on results).
  const searchBar = (
    <View style={{ paddingBottom: spacing.md }}>
      <View
        style={[
          styles.searchBar,
          {
            backgroundColor: colors.bgSurfaceAlt,
            borderRadius: radius.pill,
            paddingHorizontal: spacing.lg,
          },
        ]}
      >
        <Ionicons name="search" size={18} color={colors.textTertiary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search contacts"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.textPrimary }]}
        />
      </View>
    </View>
  );

  if (sections.length === 0) {
    return (
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}>
        {contacts.length > 0 ? searchBar : null}
        <View style={styles.empty}>
          <Text variant="body" color="tertiary">
            {query ? 'No contacts match your search.' : 'No contacts with phone numbers found.'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.contact.id}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm }}
      ListHeaderComponent={searchBar}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <Text
          variant="caption"
          color="tertiary"
          style={{ backgroundColor: colors.bgCanvas, paddingVertical: spacing.sm }}
        >
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => (
        <ContactRow
          contact={item.contact}
          user={item.user}
          onPress={() => (item.user ? handleOpenChat(item.user) : void shareInvite())}
          statusGroup={item.user ? statusGroupByPosterId.get(item.user.id) : undefined}
        />
      )}
    />
  );
}

/**
 * docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 7 — the root route
 * component below (`ChatsRouteScreen`) renders this exact same component
 * a second time as `app/_layout.tsx`'s persistent two-pane sidebar on wide
 * web (imported directly, not duplicated) — the "full chats.tsx parity"
 * sidebar scope, not a separate trimmed-down list view. Named + exported
 * (rather than staying this file's sole default export) specifically so
 * that import can happen without expo-router treating it as a second
 * route registration — a plain module import of a route file's named
 * export doesn't register a route, only a `default` export does.
 */
export function ChatsScreen() {
  const router = useRouter();
  const { session } = useSession();
  const { colors, spacing, radius, layout } = useTheme();
  const {
    data: threads,
    isLoading,
    refetch: refetchThreads,
    isRefetching,
  } = useThreads(session?.user.id);
  const { data: statusFeed } = useStatusFeed(session?.user.id);
  const statusGroupByPosterId = new Map((statusFeed ?? []).map((g) => [g.poster.id, g]));
  const [statusViewerGroup, setStatusViewerGroup] = useState<StatusFeedGroup | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [subTab, setSubTab] = useState<ChatsSubTab>('chats');
  const [search, setSearch] = useState('');

  // Device-contact name resolution (punch-list item 1, 2026-09-19;
  // extracted into `lib/contacts.ts`'s `usePhoneContactNames` follow-up,
  // same day, so `thread/[id].tsx` and `profile/[id].tsx` share the exact
  // same WhatsApp-standard priority rule) — synced here since the chat
  // list is the very first thing a user sees, not only once the Contacts
  // sub-tab is visited.
  const { resolveContactName } = usePhoneContactNames();

  const filteredThreads = (threads ?? []).filter((t) =>
    resolveContactName(t.partner).toLowerCase().includes(search.trim().toLowerCase()),
  );

  // Search lives as the FlatList's own ListHeaderComponent, not the sticky
  // AppHeader/ChatsSubHeader above it, so it scrolls away with the list
  // content instead of staying pinned — confirmed still true here, not
  // just assumed, since it's the exact thing a later regression could
  // silently break. Fill is bgSurfaceAlt (a neutral, not a wine bar) per
  // the 2026-09-14 chrome correction.
  const searchBar = (
    <View
      style={{
        // ~0.1in of breathing room below the fixed header/sub-header
        // stack, per an explicit ask — spacing.lg (16dp) already lands
        // exactly there at the same 160dp/in convention layout.barHeight
        // uses, so no new token was needed for this. No horizontal padding
        // here (or on ThreadRow below) — flush with Screen's own 16px
        // inset, matching wallet.tsx's padding exactly, per an explicit
        // "use the same margin as the wallet screen" ask.
        paddingTop: spacing.lg,
        paddingBottom: spacing.md,
      }}
    >
      <View
        style={[
          styles.searchBar,
          {
            backgroundColor: colors.bgSurfaceAlt,
            borderRadius: radius.pill,
            paddingHorizontal: spacing.lg,
          },
        ]}
      >
        <Ionicons name="search" size={18} color={colors.textTertiary} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search"
          placeholderTextColor={colors.textTertiary}
          style={[styles.searchInput, { color: colors.textPrimary }]}
        />
      </View>
    </View>
  );

  return (
    <Screen>
      <AppHeader
        title="InvolveMe"
        brand
        rightSlot={
          <Pressable onPress={() => setModalVisible(true)} hitSlop={12}>
            <Ionicons name="add" size={layout.headerIconSize} color={colors.textSecondary} />
          </Pressable>
        }
        menuItems={[
          // Scanning is a native-camera action — the web companion client
          // (docs/12-LINKED-DEVICES-WEB-SCOPING.md) is itself the thing
          // that gets linked, it never links a further device of its own.
          ...(Platform.OS !== 'web'
            ? [{ label: 'Link a device', onPress: () => router.push('/link-device') }]
            : []),
          { label: 'Settings', onPress: () => router.push('/settings') },
        ]}
      />

      {/* Fixed, non-scrolling — only the search bar + list below it scroll. */}
      <ChatsSubHeader active={subTab} onChange={setSubTab} />

      {subTab === 'contacts' ? (
        // A different data shape (device contacts, not threads) and its
        // own loading/permission states — a dedicated component rather
        // than overloading the threads FlatList below, per Batch C1.
        <ContactsList />
      ) : (
        <FlatList
          data={filteredThreads}
          keyExtractor={(t) => t.id}
          ListHeaderComponent={searchBar}
          renderItem={({ item }) => (
            <ThreadRow
              thread={item}
              onPress={() => router.push(`/thread/${item.id}`)}
              statusGroup={statusGroupByPosterId.get(item.partner.id)}
              onViewStatus={setStatusViewerGroup}
              contactName={resolveContactName(item.partner)}
            />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              {isLoading ? (
                <Text variant="body" color="tertiary">
                  Loading…
                </Text>
              ) : (
                <Text variant="body" color="tertiary">
                  {search
                    ? 'No conversations match your search.'
                    : 'No conversations yet — tap + to start one.'}
                </Text>
              )}
            </View>
          }
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetchThreads()} />
          }
        />
      )}

      <NewChatModal visible={modalVisible} onClose={() => setModalVisible(false)} />

      {statusViewerGroup ? (
        <StoryViewer
          feed={[statusViewerGroup]}
          initialPosterIndex={0}
          currentUserId={session?.user.id}
          onClose={() => setStatusViewerGroup(null)}
        />
      ) : null}
    </Screen>
  );
}

/**
 * The actual route component for `/chats`. On wide web, `app/_layout.tsx`
 * already renders `ChatsScreen` once as the persistent sidebar — showing
 * it again here as this route's own content would just be the exact same
 * thread list twice. This renders a plain "pick a conversation" state
 * instead, matching WhatsApp Web's own right-pane placeholder before
 * anything is selected. Native and narrow web are completely unaffected
 * (`useIsWideWeb()` is always `false` there) — they still get the real
 * `ChatsScreen` as this route's content, exactly as before this
 * milestone.
 */
export default function ChatsRouteScreen() {
  const isWideWeb = useIsWideWeb();
  if (!isWideWeb) return <ChatsScreen />;

  return (
    <Screen style={styles.placeholderScreen}>
      <Text variant="body" color="tertiary">
        Select a conversation to start messaging
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  placeholderScreen: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowEnd: { alignItems: 'flex-end' },
  unreadBadge: { minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  subHeaderRow: { flexDirection: 'row', paddingVertical: 8 },
  subHeaderCol: { flex: 1, alignItems: 'center' },
  subHeaderIndicator: { height: 2, width: 32, borderRadius: 1 },
  searchBar: { flexDirection: 'row', alignItems: 'center', height: 44, gap: 8 },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 0 }, // matches typography.body
  empty: { paddingTop: 48, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
});
