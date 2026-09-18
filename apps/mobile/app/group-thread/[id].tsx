import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { ChatWallpaper } from '@/components/ui/ChatWallpaper';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import {
  type GroupMember,
  useGroupInfo,
  useGroupMembers,
  useGroupMessages,
  useSendGroupMessage,
} from '@/lib/queries/groups';
import { useTheme } from '@/theme';

/** Read-only member list, reached from the header's ⋮ menu — no
 * leave/remove/rename actions yet (docs/02-DATA-MODEL.md's group-threads
 * note lists all of those as deliberate v2 scope, not an oversight). */
function GroupInfoModal({
  visible,
  onClose,
  groupName,
  members,
}: {
  visible: boolean;
  onClose: () => void;
  groupName: string | undefined;
  members: GroupMember[];
}) {
  const { spacing } = useTheme();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">{groupName ?? 'Group'}</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <Text
          variant="caption"
          color="tertiary"
          style={{ marginTop: spacing.xl, marginBottom: spacing.sm, textTransform: 'uppercase' }}
        >
          {members.length} members
        </Text>

        <FlatList
          data={members}
          keyExtractor={(m) => m.user_id}
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
              {item.role === 'admin' ? (
                <Text variant="caption" color="tertiary">
                  Owner
                </Text>
              ) : null}
            </View>
          )}
        />
      </Screen>
    </Modal>
  );
}

function GroupMessageBubble({
  body,
  senderName,
  isOwn,
}: {
  body: string;
  senderName: string | null;
  isOwn: boolean;
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
        <Text variant="body" color={isOwn ? 'inverse' : undefined}>
          {body}
        </Text>
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

  const [body, setBody] = useState('');
  const [infoVisible, setInfoVisible] = useState(false);

  const memberById = new Map((members ?? []).map((m) => [m.user_id, m]));

  const handleSend = () => {
    if (!body.trim() || !id) return;
    const text = body;
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
      <Screen style={{ paddingHorizontal: 0 }}>
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
                  />
                );
              }}
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
              value={body}
              onChangeText={setBody}
              placeholder="Message…"
              placeholderTextColor={colors.textSecondary}
              multiline
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

      <GroupInfoModal
        visible={infoVisible}
        onClose={() => setInfoVisible(false)}
        groupName={groupInfo?.name}
        members={members ?? []}
      />
    </>
  );
}

const styles = StyleSheet.create({
  bubbleRow: { flexDirection: 'row' },
  bubble: { maxWidth: '80%' },
  composer: { flexDirection: 'row', alignItems: 'flex-end' },
  input: {
    flex: 1,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 120,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
