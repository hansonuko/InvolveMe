import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { AppHeader } from '@/components/ui/AppHeader';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useFindUserByPhone, type FoundUser } from '@/lib/queries/findUserByPhone';
import { useSendMessage } from '@/lib/queries/messages';
import { type ThreadWithPartner, useThreads } from '@/lib/queries/threads';
import { useSession } from '@/lib/hooks/useSession';
import { toE164NigerianPhone } from '@/lib/phone';
import { useTheme } from '@/theme';

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
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.lg,
          borderRadius: radius.card,
          backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
        },
      ]}
    >
      <View
        style={[styles.avatar, { backgroundColor: colors.bgSurfaceAlt, borderRadius: radius.pill }]}
      >
        <Text variant="bodyMedium" color="secondary">
          {(thread.partner.display_name ?? '?').slice(0, 1).toUpperCase()}
        </Text>
      </View>
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

/** Chats/Groups/Contacts segmented row under the header. Only "Chats" is
 * a real feature — this app has no groups concept anywhere in the data
 * model or docs/02-DATA-MODEL.md, and "Contacts" would mean phone-book
 * matching, explicitly out of scope per docs/00-SESSION-HANDOFF.md ("no
 * contacts-sync/phone-book matching"). Rather than build either a fake
 * list or silently drop the two tabs, they're wired up as the same kind
 * of honest stub calls.tsx already uses for a deferred feature.
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

/** New-chat flow: phone -> lookup -> first message -> navigates into the
 * real thread once send-message creates it. A plain Modal, not a
 * bottom-sheet library — no such dependency exists in this app yet and one
 * isn't worth adding for this ("stay lite" per CLAUDE.md). */
function NewChatModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const findUser = useFindUserByPhone();
  const sendMessage = useSendMessage();

  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<FoundUser | null>(null);
  const [body, setBody] = useState('');

  const reset = () => {
    setPhone('');
    setFound(null);
    setBody('');
    findUser.reset();
    sendMessage.reset();
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

  const handleSend = () => {
    if (!found) return;
    sendMessage.mutate(
      { recipientId: found.id, body },
      {
        onSuccess: (data) => {
          handleClose();
          router.push(`/thread/${data.thread_id}`);
        },
      },
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
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
              <Text variant="bodyMedium" color="success">
                Found {found.display_name ?? 'this user'}
              </Text>
              <Text variant="caption" color="secondary">
                First message (this is what starts the chat)
              </Text>
              <TextInput
                value={body}
                onChangeText={setBody}
                placeholder="Say hello…"
                placeholderTextColor={colors.textSecondary}
                multiline
                style={[
                  styles.input,
                  styles.multiline,
                  {
                    backgroundColor: colors.bgSurfaceAlt,
                    color: colors.textPrimary,
                    borderRadius: radius.card,
                    borderColor: colors.borderSubtle,
                  },
                ]}
              />
              {sendMessage.isError ? (
                <Text variant="caption" color="danger">
                  {sendMessage.error.message}
                </Text>
              ) : null}
              <Button
                label={sendMessage.isPending ? 'Sending…' : 'Send'}
                onPress={handleSend}
                disabled={sendMessage.isPending || body.trim().length === 0}
              />
            </>
          )}
        </View>
      </Screen>
    </Modal>
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
  const [subTab, setSubTab] = useState<ChatsSubTab>('chats');
  const [search, setSearch] = useState('');

  const filteredThreads =
    subTab !== 'chats'
      ? []
      : (threads ?? []).filter((t) =>
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
        paddingHorizontal: spacing.lg,
        // ~0.1in of breathing room below the fixed header/sub-header
        // stack, per an explicit ask — spacing.lg (16dp) already lands
        // exactly there at the same 160dp/in convention layout.barHeight
        // uses, so no new token was needed for this.
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
        menuItems={[{ label: 'Settings', onPress: () => router.push('/settings') }]}
      />

      {/* Fixed, non-scrolling — only the search bar + list below it scroll. */}
      <ChatsSubHeader active={subTab} onChange={setSubTab} />

      <FlatList
        data={filteredThreads}
        keyExtractor={(t) => t.id}
        ListHeaderComponent={searchBar}
        renderItem={({ item }) => (
          <ThreadRow thread={item} onPress={() => router.push(`/thread/${item.id}`)} />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            {subTab !== 'chats' ? (
              <Text variant="body" color="tertiary">
                Not available yet.
              </Text>
            ) : isLoading ? (
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

      <NewChatModal visible={modalVisible} onClose={() => setModalVisible(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  rowEnd: { alignItems: 'flex-end' },
  unreadBadge: { minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  subHeaderRow: { flexDirection: 'row', paddingVertical: 8 },
  subHeaderCol: { flex: 1, alignItems: 'center' },
  subHeaderIndicator: { height: 2, width: 32, borderRadius: 1 },
  searchBar: { flexDirection: 'row', alignItems: 'center', height: 44, gap: 8 },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0 },
  empty: { paddingTop: 48, alignItems: 'center' },
});
