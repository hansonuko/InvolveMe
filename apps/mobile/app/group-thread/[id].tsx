import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useRef, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ActionSheet, type ActionSheetAction } from '@/components/ui/ActionSheet';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ChatWallpaper } from '@/components/ui/ChatWallpaper';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { MemberSearchList } from '@/components/groups/MemberSearchList';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { pickAndPrepareImage } from '@/lib/media';
import { useIsOnline } from '@/lib/network';
import { useOutboxStore } from '@/lib/outboxStore';
import { useShallow } from 'zustand/react/shallow';
import { type MatchedContactUser } from '@/lib/queries/contacts';
import { uploadProfileMedia } from '@/lib/queries/profileMedia';
import {
  type GroupMember,
  useAddGroupMembers,
  useCreateGroupAvatarUploadUrl,
  useGroupInfo,
  useGroupMembers,
  useGroupMessages,
  useLeaveGroup,
  useRemoveGroupMember,
  useSendGroupMessage,
  useSetGroupMemberRole,
  useUpdateGroupProfile,
} from '@/lib/queries/groups';
import { useTheme, withAlpha } from '@/theme';

const GROUP_DESCRIPTION_MAX_LENGTH = 500;
const GROUP_AVATAR_SIZE = 88;

/** "Add members" — any current member can (see add-group-members's own
 * header comment on matching WhatsApp's default permission model), not
 * just admins. Reuses the same search-as-you-type MemberSearchList
 * item 1 built, plus a chips row and a batch "Add (N)" confirm — same
 * multi-select shape NewGroupModal (chats.tsx) already establishes, so a
 * group's initial member picker and its later "add more" flow feel
 * identical. */
function AddMembersModal({
  visible,
  onClose,
  groupThreadId,
  existingMemberIds,
}: {
  visible: boolean;
  onClose: () => void;
  groupThreadId: string;
  existingMemberIds: Set<string>;
}) {
  const { colors, spacing } = useTheme();
  const addMembers = useAddGroupMembers();
  const [selected, setSelected] = useState<MatchedContactUser[]>([]);
  const [resetToken, setResetToken] = useState(0);

  const handleClose = () => {
    setSelected([]);
    setResetToken((k) => k + 1);
    addMembers.reset();
    onClose();
  };

  const handleAdd = () => {
    addMembers.mutate(
      { groupThreadId, memberIds: selected.map((m) => m.id) },
      { onSuccess: handleClose },
    );
  };

  const excludeIds = new Set([...existingMemberIds, ...selected.map((m) => m.id)]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Add members</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <View style={{ gap: spacing.md, marginTop: spacing.xl, flex: 1 }}>
          {addMembers.isError ? (
            <Text variant="caption" color="danger">
              {addMembers.error.message}
            </Text>
          ) : null}

          {selected.length > 0 ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {selected.map((m) => (
                <View
                  key={m.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: colors.bgSurfaceAlt,
                    borderRadius: 999,
                    paddingLeft: spacing.xs,
                    paddingRight: spacing.sm,
                    paddingVertical: 4,
                  }}
                >
                  <Avatar uri={m.avatar_url} displayName={m.display_name} size={28} />
                  <Text
                    variant="caption"
                    style={{ marginLeft: spacing.xs, marginRight: spacing.xs }}
                  >
                    {m.display_name ?? 'Unnamed'}
                  </Text>
                  <Pressable
                    onPress={() => setSelected((prev) => prev.filter((s) => s.id !== m.id))}
                    hitSlop={8}
                  >
                    <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}

          <MemberSearchList
            key={resetToken}
            visible={visible}
            excludeUserIds={excludeIds}
            onSelect={(user) => setSelected((prev) => [...prev, user])}
          />

          <Button
            label={
              addMembers.isPending
                ? 'Adding…'
                : `Add${selected.length ? ` (${selected.length})` : ''}`
            }
            onPress={handleAdd}
            disabled={selected.length === 0 || addMembers.isPending}
          />
        </View>
      </Screen>
    </Modal>
  );
}

/** Full WhatsApp-shaped group info/admin screen (punch-list item 2,
 * 2026-09-19), replacing the previous read-only member list. Avatar/name/
 * description are editable inline when the viewer is an admin (same
 * "editable field + it just saves" shape settings/profile.tsx already
 * establishes for the 1:1 profile screen) — plain text otherwise. Every
 * member row that isn't the viewer's own and isn't the fixed owner gets a
 * tap target opening an admin action sheet (promote/demote/remove); the
 * owner row is never actionable, since ownership has no transfer path yet
 * (fn_remove_group_member/fn_set_group_member_role both hard-block it
 * server-side too — this is a UX preempt of a call that would fail
 * anyway, not the only guard). */
function GroupInfoScreen({
  visible,
  onClose,
  groupThreadId,
  currentUserId,
}: {
  visible: boolean;
  onClose: () => void;
  groupThreadId: string | undefined;
  currentUserId: string | undefined;
}) {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();

  const { data: groupInfo } = useGroupInfo(groupThreadId);
  const { data: members } = useGroupMembers(groupThreadId);
  const updateProfile = useUpdateGroupProfile();
  const createAvatarUploadUrl = useCreateGroupAvatarUploadUrl();
  const removeMember = useRemoveGroupMember();
  const setRole = useSetGroupMemberRole();
  const leaveGroup = useLeaveGroup();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [hydrated, setHydrated] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [addMembersVisible, setAddMembersVisible] = useState(false);
  const [actionSheetMember, setActionSheetMember] = useState<GroupMember | null>(null);

  // Hydrate local editable state once the real group info arrives — same
  // "seed from server data once" shape settings/profile.tsx uses.
  if (groupInfo && !hydrated) {
    setName(groupInfo.name);
    setDescription(groupInfo.description ?? '');
    setHydrated(true);
  }

  const currentMember = members?.find((m) => m.user_id === currentUserId);
  const isAdmin = currentMember?.role === 'admin';
  const isOwner = !!groupInfo && groupInfo.created_by === currentUserId;
  const memberIds = new Set((members ?? []).map((m) => m.user_id));

  const hasProfileEdits =
    !!groupInfo &&
    (name.trim() !== groupInfo.name || description.trim() !== (groupInfo.description ?? ''));

  const handleSaveProfile = () => {
    if (!groupThreadId || !name.trim()) return;
    updateProfile.mutate({ groupThreadId, name: name.trim(), description: description.trim() });
  };

  const handlePickAvatar = async () => {
    if (!groupThreadId || !isAdmin) return;
    setAvatarError(null);
    setUploadingAvatar(true);
    try {
      const localUri = await pickAndPrepareImage('library');
      if (!localUri) return;
      const { path, token, public_url } = await createAvatarUploadUrl.mutateAsync(groupThreadId);
      await uploadProfileMedia(localUri, path, token);
      await updateProfile.mutateAsync({ groupThreadId, avatarUrl: public_url });
    } catch (e) {
      setAvatarError(e instanceof Error ? e.message : 'Could not update the group photo.');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const openMemberActions = (member: GroupMember) => {
    if (!isAdmin) return;
    if (member.user_id === currentUserId) return;
    if (member.user_id === groupInfo?.created_by) return;
    setActionSheetMember(member);
  };

  const memberActions: ActionSheetAction[] = actionSheetMember
    ? [
        {
          label: actionSheetMember.role === 'admin' ? 'Dismiss as admin' : 'Make group admin',
          onPress: () => {
            if (!groupThreadId) return;
            setRole.mutate({
              groupThreadId,
              targetUserId: actionSheetMember.user_id,
              role: actionSheetMember.role === 'admin' ? 'member' : 'admin',
            });
          },
        },
        {
          label: `Remove ${actionSheetMember.display_name ?? 'from group'}`,
          destructive: true,
          onPress: () => {
            if (!groupThreadId) return;
            Alert.alert(`Remove ${actionSheetMember.display_name ?? 'this member'}?`, undefined, [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Remove',
                style: 'destructive',
                onPress: () =>
                  removeMember.mutate({ groupThreadId, targetUserId: actionSheetMember.user_id }),
              },
            ]);
          },
        },
      ]
    : [];

  const handleExitGroup = () => {
    if (!groupThreadId) return;
    if (isOwner) {
      Alert.alert(
        "You can't leave yet",
        "As the group owner, you can't leave a group yet — ownership transfer isn't built.",
      );
      return;
    }
    Alert.alert('Leave this group?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () =>
          leaveGroup.mutate(
            { groupThreadId },
            {
              onSuccess: () => {
                onClose();
                router.replace('/(tabs)/chats');
              },
            },
          ),
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Group info</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <FlatList
          data={members ?? []}
          keyExtractor={(m) => m.user_id}
          contentContainerStyle={{ paddingBottom: spacing.xl }}
          ListHeaderComponent={
            <View style={{ marginTop: spacing.lg }}>
              <View style={{ alignItems: 'center' }}>
                <Pressable
                  onPress={handlePickAvatar}
                  disabled={!isAdmin || uploadingAvatar}
                  style={[
                    styles.avatarWrap,
                    { borderColor: colors.bgCanvas, backgroundColor: colors.bgCanvas },
                  ]}
                >
                  <Avatar
                    uri={groupInfo?.avatar_url}
                    displayName={groupInfo?.name}
                    size={GROUP_AVATAR_SIZE}
                  />
                  {isAdmin ? (
                    <View
                      style={[styles.avatarEditBadge, { backgroundColor: colors.brandPrimary }]}
                    >
                      <Ionicons name="camera" size={14} color="#fff" />
                    </View>
                  ) : null}
                </Pressable>
                {uploadingAvatar ? (
                  <Text variant="caption" color="secondary" style={{ marginTop: spacing.xs }}>
                    Uploading…
                  </Text>
                ) : null}
                {avatarError ? (
                  <Text
                    variant="caption"
                    color="danger"
                    style={{ marginTop: spacing.xs, textAlign: 'center' }}
                  >
                    {avatarError}
                  </Text>
                ) : null}
              </View>

              <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
                <Text variant="caption" color="tertiary">
                  Group name
                </Text>
                {isAdmin ? (
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    maxLength={60}
                    placeholder="Group name"
                    placeholderTextColor={colors.textTertiary}
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
                ) : (
                  <Text variant="bodyMedium">{groupInfo?.name ?? 'Group'}</Text>
                )}
              </View>

              <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                <Text variant="caption" color="tertiary">
                  Description
                </Text>
                {isAdmin ? (
                  <TextInput
                    value={description}
                    onChangeText={setDescription}
                    maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
                    multiline
                    placeholder="Add a group description"
                    placeholderTextColor={colors.textTertiary}
                    style={[
                      styles.input,
                      styles.descriptionInput,
                      {
                        backgroundColor: colors.bgSurfaceAlt,
                        color: colors.textPrimary,
                        borderRadius: radius.card,
                        borderColor: colors.borderSubtle,
                      },
                    ]}
                  />
                ) : (
                  <Text variant="body" color={groupInfo?.description ? undefined : 'tertiary'}>
                    {groupInfo?.description || 'No description yet.'}
                  </Text>
                )}
              </View>

              {isAdmin && hasProfileEdits ? (
                <View style={{ marginTop: spacing.md }}>
                  {updateProfile.isError ? (
                    <Text variant="caption" color="danger" style={{ marginBottom: spacing.sm }}>
                      {updateProfile.error.message}
                    </Text>
                  ) : null}
                  <Button
                    label={updateProfile.isPending ? 'Saving…' : 'Save changes'}
                    onPress={handleSaveProfile}
                    disabled={!name.trim() || updateProfile.isPending}
                  />
                </View>
              ) : null}

              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: spacing.xl,
                  marginBottom: spacing.sm,
                }}
              >
                <Text variant="caption" color="tertiary" style={{ textTransform: 'uppercase' }}>
                  {(members ?? []).length} members
                </Text>
                <Pressable
                  onPress={() => setAddMembersVisible(true)}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                  hitSlop={8}
                >
                  <Ionicons name="person-add-outline" size={16} color={colors.brandPrimary} />
                  <Text variant="caption" style={{ color: colors.brandPrimary }}>
                    Add
                  </Text>
                </Pressable>
              </View>
            </View>
          }
          renderItem={({ item }) => {
            const isItemOwner = item.user_id === groupInfo?.created_by;
            const actionable = isAdmin && item.user_id !== currentUserId && !isItemOwner;
            return (
              <Pressable
                onPress={() => openMemberActions(item)}
                disabled={!actionable}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: spacing.sm,
                  gap: spacing.md,
                }}
              >
                <Avatar uri={item.avatar_url} displayName={item.display_name} size={44} />
                <Text variant="bodyMedium" style={{ flex: 1 }}>
                  {item.user_id === currentUserId ? 'You' : (item.display_name ?? 'Unnamed')}
                </Text>
                {isItemOwner ? (
                  <Text variant="caption" color="tertiary">
                    Owner
                  </Text>
                ) : item.role === 'admin' ? (
                  <Text variant="caption" color="tertiary">
                    Admin
                  </Text>
                ) : null}
              </Pressable>
            );
          }}
          ListFooterComponent={
            <Pressable
              onPress={handleExitGroup}
              style={{ paddingVertical: spacing.lg, alignItems: 'center' }}
            >
              <Text variant="bodyMedium" color="danger">
                Exit group
              </Text>
            </Pressable>
          }
        />
      </Screen>

      <ActionSheet
        visible={!!actionSheetMember}
        onClose={() => setActionSheetMember(null)}
        title={actionSheetMember?.display_name ?? undefined}
        actions={memberActions}
      />

      {groupThreadId ? (
        <AddMembersModal
          visible={addMembersVisible}
          onClose={() => setAddMembersVisible(false)}
          groupThreadId={groupThreadId}
          existingMemberIds={memberIds}
        />
      ) : null}
    </Modal>
  );
}

function GroupMessageBubble({
  body,
  senderName,
  isOwn,
  isForwarded,
}: {
  body: string;
  senderName: string | null;
  isOwn: boolean;
  isForwarded: boolean;
}) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View
      style={[
        styles.bubbleRow,
        { justifyContent: isOwn ? 'flex-end' : 'flex-start', marginBottom: spacing.sm },
      ]}
    >
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: isOwn ? colors.brandPrimary : colors.bgSurfaceAlt,
            borderRadius: radius.bubble,
            padding: spacing.md,
          },
        ]}
      >
        {/* Sender name shown above every non-own message — a group has no
            single "the other participant" a 1:1 thread has, so there's no
            other way to tell who sent what. */}
        {!isOwn ? (
          <Text
            variant="caption"
            color="secondary"
            style={{ marginBottom: spacing.xs, fontWeight: '700' }}
          >
            {senderName ?? 'Unknown'}
          </Text>
        ) : null}
        {isForwarded ? (
          <View
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: spacing.xs }}
          >
            <Ionicons
              name="arrow-redo-outline"
              size={12}
              color={isOwn ? withAlpha(colors.textInverse, 0.75) : colors.textSecondary}
            />
            <Text
              variant="caption"
              color={isOwn ? undefined : 'secondary'}
              style={
                isOwn
                  ? { color: withAlpha(colors.textInverse, 0.75), fontStyle: 'italic' }
                  : { fontStyle: 'italic' }
              }
            >
              Forwarded
            </Text>
          </View>
        ) : null}
        <Text variant="body" color={isOwn ? 'inverse' : undefined}>
          {body}
        </Text>
      </View>
    </View>
  );
}

/** A group message composed while offline, queued in the outbox
 * (docs/13-OFFLINE-MODE-SCOPING.md) — same shape thread/[id].tsx's own
 * OutboxPendingBubble establishes for 1:1 threads. */
function GroupOutboxPendingBubble({ body }: { body: string }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View style={[styles.bubbleRow, { justifyContent: 'flex-end', marginBottom: spacing.sm }]}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: colors.bgSurfaceAlt,
            borderRadius: radius.bubble,
            padding: spacing.md,
            borderWidth: 1,
            borderColor: colors.borderSubtle,
            borderStyle: 'dashed',
          },
        ]}
      >
        <Text variant="body">{body}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs, gap: 4 }}>
          <Ionicons name="time-outline" size={12} color={colors.textSecondary} />
          <Text variant="caption" color="secondary">
            Waiting for connection…
          </Text>
        </View>
      </View>
    </View>
  );
}

export default function GroupThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const currentUserId = session?.user.id;

  const { data: groupInfo } = useGroupInfo(id);
  const { data: members } = useGroupMembers(id);
  const { data: messages, isLoading } = useGroupMessages(id);
  const sendMessage = useSendGroupMessage();

  const isOnline = useIsOnline();
  // See thread/[id].tsx's identical selector for why useShallow matters
  // here, not just style.
  const outboxItems = useOutboxStore(
    useShallow((s) =>
      s.items.filter((i) => i.target.kind === 'group' && i.target.groupThreadId === id),
    ),
  );

  const [body, setBody] = useState('');
  const [infoVisible, setInfoVisible] = useState(false);
  const composerInputRef = useRef<TextInput>(null);

  const memberById = new Map((members ?? []).map((m) => [m.user_id, m]));

  const handleSend = () => {
    if (!body.trim() || !id) return;
    const text = body;

    // Offline outbox (docs/13-OFFLINE-MODE-SCOPING.md) — same posture
    // thread/[id].tsx's own 1:1 wiring establishes.
    if (!isOnline && currentUserId) {
      useOutboxStore.getState().enqueue({
        clientMessageId: Crypto.randomUUID(),
        body: text,
        createdAt: new Date().toISOString(),
        senderId: currentUserId,
        target: { kind: 'group', groupThreadId: id },
      });
      setBody('');
      return;
    }

    sendMessage.mutate(
      { groupThreadId: id, body: text },
      {
        onSuccess: () => setBody(''),
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: groupInfo?.name ?? 'Group',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
          headerRight: () => (
            <Pressable onPress={() => setInfoVisible(true)} hitSlop={12}>
              <Ionicons name="people" size={22} color={colors.textSecondary} />
            </Pressable>
          ),
        }}
      />
      <Screen style={{ paddingHorizontal: 0 }} edges={['right', 'bottom', 'left']}>
        <ChatWallpaper />

        <KeyboardAvoidingScreen>
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <Text variant="caption" color="secondary">
              Free to send — group messaging doesn&apos;t cost credits yet.
            </Text>
          </View>

          {isLoading ? (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <Text variant="body" color="secondary">
                Loading…
              </Text>
            </View>
          ) : (
            <FlatList
              data={messages}
              keyExtractor={(m) => m.id}
              contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}
              renderItem={({ item }) => {
                const isOwn = item.sender_id === currentUserId;
                return (
                  <GroupMessageBubble
                    body={item.body}
                    senderName={memberById.get(item.sender_id)?.display_name ?? null}
                    isOwn={isOwn}
                    isForwarded={item.is_forwarded}
                  />
                );
              }}
              ListFooterComponent={
                outboxItems.length ? (
                  <>
                    {outboxItems.map((item) => (
                      <GroupOutboxPendingBubble key={item.clientMessageId} body={item.body} />
                    ))}
                  </>
                ) : null
              }
            />
          )}

          {sendMessage.isError ? (
            <View style={{ paddingHorizontal: spacing.lg }}>
              <Text variant="caption" color="danger">
                {sendMessage.error.message}
              </Text>
            </View>
          ) : null}

          <View
            style={[
              styles.composer,
              { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
            ]}
          >
            <TextInput
              ref={composerInputRef}
              value={body}
              onChangeText={setBody}
              placeholder="Message…"
              placeholderTextColor={colors.textSecondary}
              multiline
              style={[
                styles.input,
                {
                  flex: 1,
                  backgroundColor: colors.bgSurfaceAlt,
                  color: colors.textPrimary,
                  borderRadius: radius.card,
                  borderColor: colors.borderSubtle,
                  maxHeight: 120,
                },
              ]}
            />
            <Pressable
              onPress={sendMessage.isPending || !body.trim() ? undefined : handleSend}
              disabled={sendMessage.isPending || !body.trim()}
              hitSlop={4}
              style={[
                styles.sendButton,
                {
                  backgroundColor: colors.brandPrimary,
                  opacity: sendMessage.isPending || !body.trim() ? 0.4 : 1,
                },
              ]}
            >
              <Ionicons name="send" size={20} color={colors.textInverse} />
            </Pressable>
          </View>
        </KeyboardAvoidingScreen>
      </Screen>

      <GroupInfoScreen
        visible={infoVisible}
        onClose={() => setInfoVisible(false)}
        groupThreadId={id}
        currentUserId={currentUserId}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: 'row' },
  bubble: { maxWidth: '80%' },
  composer: { flexDirection: 'row', alignItems: 'flex-end' },
  input: {
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 17, // matches typography.body — punch-list item 4, 2026-09-19
  },
  descriptionInput: { minHeight: 60, textAlignVertical: 'top' },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarWrap: { borderRadius: 999, borderWidth: 4, padding: 0, alignSelf: 'center' },
  avatarEditBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
