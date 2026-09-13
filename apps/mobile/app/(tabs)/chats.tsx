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

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useFindUserByPhone, type FoundUser } from '@/lib/queries/findUserByPhone';
import { useSendMessage } from '@/lib/queries/messages';
import { type ThreadWithPartner, useThreads } from '@/lib/queries/threads';
import { useSession } from '@/lib/hooks/useSession';
import { toE164NigerianPhone } from '@/lib/phone';
import { useTheme } from '@/theme';

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
        <Text variant="bodyMedium">
          {(thread.partner.display_name ?? '?').slice(0, 1).toUpperCase()}
        </Text>
      </View>
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <Text variant="bodyMedium">{thread.partner.display_name ?? 'Unnamed'}</Text>
        {thread.is_blocked ? (
          <Text variant="caption" color="danger">
            Blocked
          </Text>
        ) : null}
      </View>
    </Pressable>
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
  const { spacing } = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const {
    data: threads,
    isLoading,
    refetch: refetchThreads,
    isRefetching,
  } = useThreads(session?.user.id);
  const [modalVisible, setModalVisible] = useState(false);

  return (
    <Screen>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: spacing.md,
        }}
      >
        <Text variant="display">Chats</Text>
        <View style={{ flexDirection: 'row', gap: spacing.lg, alignItems: 'center' }}>
          <Pressable onPress={() => router.push('/settings')} hitSlop={12}>
            <Text variant="body" color="secondary">
              Settings
            </Text>
          </Pressable>
          <Pressable onPress={() => setModalVisible(true)} hitSlop={12}>
            <Text variant="title" color="brand">
              +
            </Text>
          </Pressable>
        </View>
      </View>

      {isLoading ? (
        <Text variant="body" color="secondary">
          Loading…
        </Text>
      ) : !threads?.length ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text variant="body" color="secondary">
            No conversations yet — tap + to start one.
          </Text>
        </View>
      ) : (
        <FlatList
          data={threads}
          keyExtractor={(t) => t.id}
          renderItem={({ item }) => (
            <ThreadRow thread={item} onPress={() => router.push(`/thread/${item.id}`)} />
          )}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetchThreads()} />
          }
        />
      )}

      <NewChatModal visible={modalVisible} onClose={() => setModalVisible(false)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
});
