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
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { MemberSearchList } from '@/components/groups/MemberSearchList';
import { type MatchedContactUser } from '@/lib/queries/contacts';
import { type GroupThread, useCreateGroup, useGroups } from '@/lib/queries/groups';
import { useSession } from '@/lib/hooks/useSession';
import { useTheme } from '@/theme';

// Same 52dp row-avatar size every other list row in this app uses (see
// (tabs)/chats.tsx's own AVATAR_SIZE comment for the full reasoning) —
// kept as its own local constant rather than importing chats.tsx's,
// matching the "own file, own small constants" split this move already
// establishes for the rest of what used to live there.
const AVATAR_SIZE = 52;

/** Same-day -> "3:00 PM", otherwise a short date — duplicated from
 * (tabs)/chats.tsx's own ThreadRow (kept, not extracted into a shared
 * util) rather than a cross-file import for one small pure function; this
 * app already has that exact precedent (group-thread/[id].tsx's emoji
 * wiring used to carry the same "kept duplicated... a bigger, separate
 * refactor" reasoning before that feature was removed entirely). */
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

/** Group creation (2026-09-18, punch-list item 11; search-as-you-type
 * rebuild 2026-09-19; moved from (tabs)/chats.tsx to its own tab per
 * docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A5 — same component,
 * same behavior, just no longer nested under the Chats screen's own
 * segmented row): name + a search-driven member picker built on the
 * shared MemberSearchList component. */
function NewGroupModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const createGroup = useCreateGroup();

  const [name, setName] = useState('');
  const [selectedMembers, setSelectedMembers] = useState<MatchedContactUser[]>([]);
  // Bumped on close so MemberSearchList clears its own search box/cached
  // device-contacts read for the next time this modal opens.
  const [resetToken, setResetToken] = useState(0);

  const reset = () => {
    setName('');
    setSelectedMembers([]);
    setResetToken((k) => k + 1);
    createGroup.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const removeMember = (userId: string) => {
    setSelectedMembers((prev) => prev.filter((m) => m.id !== userId));
  };

  const handleCreate = () => {
    createGroup.mutate(
      { name: name.trim(), memberIds: selectedMembers.map((m) => m.id) },
      {
        onSuccess: (data) => {
          handleClose();
          router.push(`/group-thread/${data.group_thread_id}`);
        },
      },
    );
  };

  const canCreate = name.trim().length > 0 && selectedMembers.length > 0 && !createGroup.isPending;

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

            {selectedMembers.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {selectedMembers.map((m) => (
                  <View
                    key={m.id}
                    style={[
                      styles.chip,
                      {
                        backgroundColor: colors.bgSurfaceAlt,
                        borderRadius: radius.pill,
                        paddingLeft: spacing.xs,
                        paddingRight: spacing.sm,
                      },
                    ]}
                  >
                    <Avatar uri={m.avatar_url} displayName={m.display_name} size={28} />
                    <Text
                      variant="caption"
                      style={{ marginLeft: spacing.xs, marginRight: spacing.xs }}
                    >
                      {m.display_name ?? 'Unnamed'}
                    </Text>
                    <Pressable onPress={() => removeMember(m.id)} hitSlop={8}>
                      <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}

            <MemberSearchList
              key={resetToken}
              visible={visible}
              excludeUserIds={new Set(selectedMembers.map((m) => m.id))}
              onSelect={(user) =>
                setSelectedMembers((prev) =>
                  prev.some((m) => m.id === user.id) ? prev : [...prev, user],
                )
              }
            />

            <Button
              label={
                createGroup.isPending
                  ? 'Creating…'
                  : `Create group${selectedMembers.length ? ` (${selectedMembers.length})` : ''}`
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

const GROUP_QUICK_ROW_AVATAR_SIZE = 56;
const GROUP_QUICK_ROW_ITEM_WIDTH = 68;

/** Horizontal "your groups" strip (punch-list item 3, 2026-09-19) — quick
 * access to every group the user created or belongs to, one tap to open,
 * without scrolling the full vertical list below it. */
function GroupsQuickRow({
  groups,
  onPress,
}: {
  groups: GroupThread[];
  onPress: (id: string) => void;
}) {
  const { spacing } = useTheme();
  return (
    <FlatList
      horizontal
      showsHorizontalScrollIndicator={false}
      data={groups}
      keyExtractor={(g) => g.id}
      contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.lg }}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => onPress(item.id)}
          style={{ alignItems: 'center', width: GROUP_QUICK_ROW_ITEM_WIDTH }}
        >
          <Avatar
            uri={item.avatar_url}
            displayName={item.name}
            size={GROUP_QUICK_ROW_AVATAR_SIZE}
          />
          <Text
            variant="caption"
            numberOfLines={1}
            style={{ marginTop: spacing.xs, textAlign: 'center' }}
          >
            {item.name}
          </Text>
        </Pressable>
      )}
    />
  );
}

/**
 * Groups tab (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A5) —
 * replaces the Calls tab slot in the bottom bar. Was previously the
 * middle segment of the Chats screen's own Chats/Groups/Contacts row;
 * lifted out wholesale (same GroupsList/GroupsQuickRow/NewGroupModal
 * components, same free-messaging-only billing posture per
 * docs/03-ECONOMY-LEDGER.md §10) now that it's a real top-level surface
 * instead of a sub-tab. Calls itself is disabled, not deleted — see
 * (tabs)/_layout.tsx's own comment.
 */
export default function GroupsScreen() {
  const router = useRouter();
  const { session } = useSession();
  const { colors, spacing, layout } = useTheme();
  const { data: groups, isLoading, refetch, isRefetching } = useGroups(session?.user.id);
  const [groupModalVisible, setGroupModalVisible] = useState(false);

  const openGroup = (groupId: string) => router.push(`/group-thread/${groupId}`);

  return (
    <Screen>
      <AppHeader
        title="Groups"
        rightSlot={
          <Pressable onPress={() => setGroupModalVisible(true)} hitSlop={12}>
            <Ionicons name="add" size={layout.headerIconSize} color={colors.textSecondary} />
          </Pressable>
        }
        menuItems={[{ label: 'Settings', onPress: () => router.push('/settings') }]}
      />

      <FlatList
        data={groups ?? []}
        keyExtractor={(g) => g.id}
        contentContainerStyle={{ paddingTop: spacing.sm }}
        renderItem={({ item }) => <GroupRow group={item} onPress={() => openGroup(item.id)} />}
        ListHeaderComponent={
          groups && groups.length > 0 ? (
            <View style={{ marginBottom: spacing.md }}>
              <Text
                variant="caption"
                color="tertiary"
                style={{
                  paddingHorizontal: spacing.lg,
                  marginBottom: spacing.sm,
                  textTransform: 'uppercase',
                }}
              >
                Your groups
              </Text>
              <GroupsQuickRow groups={groups} onPress={openGroup} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text variant="body" color="tertiary">
              {isLoading ? 'Loading…' : 'No groups yet — tap + to start one.'}
            </Text>
          </View>
        }
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
        }
      />

      <NewGroupModal visible={groupModalVisible} onClose={() => setGroupModalVisible(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  empty: { paddingTop: 48, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
});
