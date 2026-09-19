import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  FlatList,
  Linking,
  Modal,
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
import { type DeviceContact, useDeviceContacts } from '@/lib/contacts';
import { shareInvite } from '@/lib/invite';
import { type MatchedContactUser, useFindUsersByPhones } from '@/lib/queries/contacts';
import { useFindUserByPhone, type FoundUser } from '@/lib/queries/findUserByPhone';
import { type GroupThread, useCreateGroup, useGroups } from '@/lib/queries/groups';
import { type ThreadWithPartner, useStartThread, useThreads } from '@/lib/queries/threads';
import { useSession } from '@/lib/hooks/useSession';
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

function ThreadRow({ thread, onPress }: { thread: ThreadWithPartner; onPress: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const [sheetVisible, setSheetVisible] = useState(false);

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
      <Pressable onPress={() => setSheetVisible(true)} hitSlop={4}>
        <Avatar
          uri={thread.partner.avatar_url}
          displayName={thread.partner.display_name}
          size={AVATAR_SIZE}
        />
      </Pressable>
      <ActionSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        title={thread.partner.display_name ?? 'Unnamed'}
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
        <Text variant="bodyMedium">{thread.partner.display_name ?? 'Unnamed'}</Text>
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

type ChatsSubTab = 'chats' | 'groups' | 'contacts';

const SUB_TABS: { key: ChatsSubTab; label: string }[] = [
  { key: 'chats', label: 'Chats' },
  { key: 'groups', label: 'Groups' },
  { key: 'contacts', label: 'Contacts' },
];

/** Chats/Groups/Contacts segmented row under the header. "Groups" is real
 * as of 2026-09-18 (punch-list item 11) — free messaging only, see
 * GroupsList below; the paid billing model (docs/03-ECONOMY-LEDGER.md
 * §10) stays kill-switched off, unrelated to this UI existing. "Contacts"
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
function NewChatModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const findUser = useFindUserByPhone();
  const startThread = useStartThread();

  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<FoundUser | null>(null);

  const reset = () => {
    setPhone('');
    setFound(null);
    findUser.reset();
    startThread.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleLookup = () => {
    findUser.mutate(toE164NigerianPhone(phone), {
      onSuccess: (user) => setFound(user),
    });
  };

  const handleOpenChat = () => {
    if (!found) return;
    startThread.mutate(found.id, {
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

          <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
            <Text variant="caption" color="secondary">
              Their phone number
            </Text>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="0801 234 5678"
              placeholderTextColor={colors.textSecondary}
              keyboardType="phone-pad"
              editable={!found}
              style={[
                styles.input,
                {
                  backgroundColor: colors.bgSurfaceAlt,
                  color: colors.textPrimary,
                  borderRadius: radius.card,
                  borderColor: colors.borderSubtle,
                },
              ]}
            />

            {findUser.isError ? (
              <Text variant="caption" color="danger">
                {findUser.error.message}
              </Text>
            ) : null}

            {!found ? (
              <Button
                label={findUser.isPending ? 'Looking up…' : 'Find'}
                onPress={handleLookup}
                disabled={findUser.isPending || phone.length < 8}
              />
            ) : (
              <>
                {startThread.isError ? (
                  <Text variant="caption" color="danger">
                    {startThread.error.message}
                  </Text>
                ) : null}
                <Pressable
                  onPress={startThread.isPending ? undefined : handleOpenChat}
                  disabled={startThread.isPending}
                  style={({ pressed }) => [
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.md,
                      paddingVertical: spacing.sm,
                      borderRadius: radius.card,
                      backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
                      opacity: startThread.isPending ? 0.6 : 1,
                    },
                  ]}
                >
                  <Avatar uri={found.avatar_url} displayName={found.display_name} size={52} />
                  <View style={{ flex: 1 }}>
                    <Text variant="bodyMedium">{found.display_name ?? 'Unnamed'}</Text>
                    <Text variant="caption" color="tertiary">
                      {startThread.isPending ? 'Opening chat…' : 'Tap to start chatting'}
                    </Text>
                  </View>
                </Pressable>
              </>
            )}
          </View>
        </KeyboardAvoidingScreen>
      </Screen>
    </Modal>
  );
}

function GroupRow({ group, onPress }: { group: GroupThread; onPress: () => void }) {
  const { colors, spacing, radius } = useTheme();
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
      {/* No group avatar upload yet (docs/02-DATA-MODEL.md's group-threads
          note, still-unresolved v2 list) — initials fallback via Avatar's
          own displayName-only mode, same as any user with no avatar_url. */}
      <Avatar uri={group.avatar_url} displayName={group.name} size={AVATAR_SIZE} />
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text variant="bodyMedium">{group.name}</Text>
        <Text variant="caption" color="tertiary" numberOfLines={1}>
          {group.last_message_body ?? `${group.member_count} members`}
        </Text>
      </View>
      {group.last_message_at ? (
        <Text variant="caption" color="tertiary" style={{ marginLeft: spacing.sm }}>
          {formatThreadTimestamp(group.last_message_at)}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Group creation (2026-09-18, punch-list item 11): name + a multi-select
 * member picker built from the same device-contacts-matched-to-InvolveMe-
 * users data ContactsList already fetches — a group can only be started
 * with people already on InvolveMe (fn_create_group_thread's own
 * member_not_found check enforces this server-side too), so there's no
 * separate phone-lookup flow to build here. Free messaging only, per
 * useCreateGroup's own comment — nothing here is a pricing decision. */
function NewGroupModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const { status, error, sync } = useDeviceContacts();
  const findUsers = useFindUsersByPhones();
  const createGroup = useCreateGroup();

  const [name, setName] = useState('');
  const [candidates, setCandidates] = useState<MatchedContactUser[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const deviceContacts = await sync();
      if (cancelled || deviceContacts.length === 0) return;

      const allPhones = [
        ...new Set(deviceContacts.flatMap((c) => c.phones.map(toE164NigerianPhone))),
      ];
      findUsers.mutate(allPhones, {
        onSuccess: (data) => {
          if (!cancelled) setCandidates(data.matches);
        },
      });
    })();
    return () => {
      cancelled = true;
    };
    // Re-syncs each time the modal opens, not on every re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const reset = () => {
    setName('');
    setCandidates([]);
    setSelectedIds(new Set());
    createGroup.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const toggleSelected = (userId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleCreate = () => {
    createGroup.mutate(
      { name: name.trim(), memberIds: [...selectedIds] },
      {
        onSuccess: (data) => {
          handleClose();
          router.push(`/group-thread/${data.group_thread_id}`);
        },
      },
    );
  };

  const canCreate = name.trim().length > 0 && selectedIds.size > 0 && !createGroup.isPending;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <KeyboardAvoidingScreen>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text variant="title">New group</Text>
            <Pressable onPress={handleClose} hitSlop={12}>
              <Text variant="body" color="secondary">
                Close
              </Text>
            </Pressable>
          </View>

          <View style={{ gap: spacing.md, marginTop: spacing.xl, flex: 1 }}>
            <Text variant="caption" color="secondary">
              Group name
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Weekend Trip"
              placeholderTextColor={colors.textSecondary}
              maxLength={60}
              style={[
                styles.input,
                {
                  backgroundColor: colors.bgSurfaceAlt,
                  color: colors.textPrimary,
                  borderRadius: radius.card,
                  borderColor: colors.borderSubtle,
                },
              ]}
            />

            <Text variant="caption" color="secondary" style={{ marginTop: spacing.sm }}>
              Add members (only people already on InvolveMe can be added)
            </Text>

            {createGroup.isError ? (
              <Text variant="caption" color="danger">
                {createGroup.error.message}
              </Text>
            ) : null}

            {status === 'denied' ? (
              <View style={styles.empty}>
                <Text
                  variant="body"
                  color="tertiary"
                  style={{ textAlign: 'center', marginBottom: spacing.md }}
                >
                  Allow contacts access to pick group members from your phonebook.
                </Text>
                <Button label="Open settings" onPress={() => void Linking.openSettings()} />
              </View>
            ) : status === 'error' ? (
              <View style={styles.empty}>
                <Text variant="body" color="danger">
                  {error}
                </Text>
              </View>
            ) : status === 'idle' ||
              status === 'requesting' ||
              status === 'loading' ||
              findUsers.isPending ? (
              <View style={styles.empty}>
                <Text variant="body" color="tertiary">
                  {status === 'requesting' ? 'Requesting contacts access…' : 'Loading contacts…'}
                </Text>
              </View>
            ) : candidates.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="body" color="tertiary" style={{ textAlign: 'center' }}>
                  None of your contacts are on InvolveMe yet.
                </Text>
              </View>
            ) : (
              <FlatList
                data={candidates}
                keyExtractor={(u) => u.id}
                style={{ flex: 1 }}
                renderItem={({ item }) => {
                  const selected = selectedIds.has(item.id);
                  return (
                    <Pressable
                      onPress={() => toggleSelected(item.id)}
                      style={({ pressed }) => [
                        styles.row,
                        {
                          paddingVertical: spacing.sm,
                          backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
                        },
                      ]}
                    >
                      <Avatar uri={item.avatar_url} displayName={item.display_name} size={44} />
                      <Text variant="bodyMedium" style={{ flex: 1, marginLeft: spacing.md }}>
                        {item.display_name ?? 'Unnamed'}
                      </Text>
                      <Ionicons
                        name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                        size={22}
                        color={selected ? colors.brandPrimary : colors.textTertiary}
                      />
                    </Pressable>
                  );
                }}
              />
            )}

            <Button
              label={
                createGroup.isPending
                  ? 'Creating…'
                  : `Create group${selectedIds.size ? ` (${selectedIds.size})` : ''}`
              }
              onPress={handleCreate}
              disabled={!canCreate}
            />
          </View>
        </KeyboardAvoidingScreen>
      </Screen>
    </Modal>
  );
}

/** Groups the current user belongs to — same list-row shape ThreadRow uses,
 * a dedicated component (not a shared FlatList with threads) because the
 * data source and empty/loading states are different, same reasoning
 * ContactsList already documents for itself. */
function GroupsList() {
  const router = useRouter();
  const { session } = useSession();
  const { spacing } = useTheme();
  const { data: groups, isLoading, refetch, isRefetching } = useGroups(session?.user.id);

  return (
    <FlatList
      data={groups ?? []}
      keyExtractor={(g) => g.id}
      contentContainerStyle={{ paddingTop: spacing.sm }}
      renderItem={({ item }) => (
        <GroupRow group={item} onPress={() => router.push(`/group-thread/${item.id}`)} />
      )}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Text variant="body" color="tertiary">
            {isLoading ? 'Loading…' : 'No groups yet — tap + to start one.'}
          </Text>
        </View>
      }
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
    />
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
}: {
  contact: DeviceContact;
  user: MatchedContactUser | null;
  onPress: () => void;
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
  const { status, error, sync } = useDeviceContacts();
  const findUsers = useFindUsersByPhones();
  const startThread = useStartThread();
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
        />
      )}
    />
  );
}

export default function ChatsScreen() {
  const router = useRouter();
  const { session } = useSession();
  const { colors, spacing, radius, layout } = useTheme();
  const {
    data: threads,
    isLoading,
    refetch: refetchThreads,
    isRefetching,
  } = useThreads(session?.user.id);
  const [modalVisible, setModalVisible] = useState(false);
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [subTab, setSubTab] = useState<ChatsSubTab>('chats');
  const [search, setSearch] = useState('');

  const filteredThreads = (threads ?? []).filter((t) =>
    (t.partner.display_name ?? '').toLowerCase().includes(search.trim().toLowerCase()),
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
          <Pressable
            onPress={() =>
              subTab === 'groups' ? setGroupModalVisible(true) : setModalVisible(true)
            }
            hitSlop={12}
          >
            <Ionicons name="add" size={layout.headerIconSize} color={colors.textSecondary} />
          </Pressable>
        }
        menuItems={[{ label: 'Settings', onPress: () => router.push('/settings') }]}
      />

      {/* Fixed, non-scrolling — only the search bar + list below it scroll. */}
      <ChatsSubHeader active={subTab} onChange={setSubTab} />

      {subTab === 'contacts' ? (
        // A different data shape (device contacts, not threads) and its
        // own loading/permission states — a dedicated component rather
        // than overloading the threads FlatList below, per Batch C1.
        <ContactsList />
      ) : subTab === 'groups' ? (
        // Real groups (2026-09-18) — own data source, own component, same
        // reasoning as ContactsList above.
        <GroupsList />
      ) : (
        <FlatList
          data={filteredThreads}
          keyExtractor={(t) => t.id}
          ListHeaderComponent={searchBar}
          renderItem={({ item }) => (
            <ThreadRow thread={item} onPress={() => router.push(`/thread/${item.id}`)} />
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
      <NewGroupModal visible={groupModalVisible} onClose={() => setGroupModalVisible(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
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
});
