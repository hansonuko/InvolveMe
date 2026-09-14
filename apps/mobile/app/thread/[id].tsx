import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { ChatWallpaper } from '@/components/ui/ChatWallpaper';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { type Message, useSendMessage, useThreadMessages } from '@/lib/queries/messages';
import { useReportUser } from '@/lib/queries/profile';
import { useMarkThreadRead, useSetThreadBlocked } from '@/lib/queries/threads';
import { supabase } from '@/lib/supabase';
import { useTheme, withAlpha } from '@/theme';

interface ThreadHeaderInfo {
  partnerId: string;
  partnerName: string | null;
  isPayer: boolean;
  blockedByMe: boolean;
  blockedByPartner: boolean;
  /** `null` if the partner has read receipts turned off — thread/[id].tsx
   * must not render a "read" indicator in that case, per the privacy
   * toggle's own contract (see lib/queries/profile.ts). */
  partnerLastReadAt: string | null;
}

/** Title, payer/payee role, block state, and (privacy-gated) the
 * partner's read cursor — everything the header/menu/read-receipt UI
 * needs. Fetched directly, not through a TanStack Query hook — refetched
 * wholesale after any block/unblock action rather than kept live, which
 * is an acceptable v1 simplification (same one useThreads' partner join
 * already makes for similar one-shot metadata). */
function useThreadHeaderInfo(
  threadId: string | undefined,
  currentUserId: string | undefined,
  refetchKey: number,
) {
  const [info, setInfo] = useState<ThreadHeaderInfo | null>(null);

  useEffect(() => {
    if (!threadId || !currentUserId) return;
    let cancelled = false;

    (async () => {
      const { data: thread } = await supabase
        .from('threads')
        .select(
          'participant_a, participant_b, blocked_by, participant_a_last_read_at, participant_b_last_read_at',
        )
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || cancelled) return;

      const isPayer = thread.participant_a === currentUserId;
      const partnerId = isPayer ? thread.participant_b : thread.participant_a;
      const partnerLastReadAtRaw = isPayer
        ? thread.participant_b_last_read_at
        : thread.participant_a_last_read_at;

      const { data: partner } = await supabase
        .from('users')
        .select('display_name, read_receipts_enabled')
        .eq('id', partnerId)
        .maybeSingle();
      if (cancelled) return;

      setInfo({
        partnerId,
        partnerName: partner?.display_name ?? null,
        isPayer,
        blockedByMe: thread.blocked_by === currentUserId,
        blockedByPartner: !!thread.blocked_by && thread.blocked_by !== currentUserId,
        partnerLastReadAt: partner?.read_receipts_enabled ? partnerLastReadAtRaw : null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [threadId, currentUserId, refetchKey]);

  return info;
}

const REPORT_REASONS = [
  'Spam or scam',
  'Harassment or abuse',
  'Inappropriate content',
  'Something else',
];

/** Block/unblock + report, from the one place WhatsApp/Telegram both put
 * them: the conversation itself, not just buried in global Settings
 * (which also has a phone-number-based path to both, for when there's no
 * shared thread — see settings/index.tsx). */
function ThreadOverflowMenu({
  visible,
  onClose,
  threadId,
  partnerId,
  blockedByMe,
  currentUserId,
  onBlockedChange,
}: {
  visible: boolean;
  onClose: () => void;
  threadId: string;
  partnerId: string;
  blockedByMe: boolean;
  currentUserId: string;
  /** Called after a block/unblock mutation succeeds — useThreadHeaderInfo
   * is a one-shot fetch, not a live subscription, so the parent needs an
   * explicit nudge to re-fetch rather than picking this up automatically. */
  onBlockedChange: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const setBlocked = useSetThreadBlocked();
  const reportUser = useReportUser();
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);

  const handleToggleBlock = () => {
    onClose();
    const action = blockedByMe ? 'Unblock' : 'Block';
    Alert.alert(`${action} this contact?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: action,
        style: blockedByMe ? 'default' : 'destructive',
        onPress: () =>
          setBlocked.mutate({ threadId, blocked: !blockedByMe }, { onSuccess: onBlockedChange }),
      },
    ]);
  };

  const handleSubmitReport = () => {
    if (!reason) return;
    reportUser.mutate(
      { reporterId: currentUserId, reportedUserId: partnerId, threadId, reason },
      {
        onSuccess: () => {
          setReportOpen(false);
          setReason(null);
          Alert.alert('Reported', 'Thanks — our team will review this.');
        },
      },
    );
  };

  return (
    <>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <View
            style={[
              styles.menu,
              {
                backgroundColor: colors.bgSurface,
                borderColor: colors.borderSubtle,
                borderRadius: radius.card,
              },
            ]}
          >
            <Pressable
              style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.lg }}
              onPress={handleToggleBlock}
            >
              <Text variant="bodyMedium" color={blockedByMe ? 'primary' : 'danger'}>
                {blockedByMe ? 'Unblock contact' : 'Block contact'}
              </Text>
            </Pressable>
            <Pressable
              style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.lg }}
              onPress={() => {
                onClose();
                setReportOpen(true);
              }}
            >
              <Text variant="bodyMedium" color="danger">
                Report contact
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={reportOpen} animationType="slide" onRequestClose={() => setReportOpen(false)}>
        <Screen>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text variant="title">Report contact</Text>
            <Pressable onPress={() => setReportOpen(false)} hitSlop={12}>
              <Text variant="body" color="secondary">
                Close
              </Text>
            </Pressable>
          </View>
          <View style={{ gap: spacing.xs, marginTop: spacing.xl }}>
            {REPORT_REASONS.map((r) => (
              <Pressable
                key={r}
                onPress={() => setReason(r)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.sm,
                  paddingVertical: spacing.xs,
                }}
              >
                <Text color={reason === r ? 'secondary' : 'tertiary'}>
                  {reason === r ? '●' : '○'}
                </Text>
                <Text variant="body">{r}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            onPress={handleSubmitReport}
            disabled={!reason || reportUser.isPending}
            style={{ marginTop: spacing.xl, opacity: !reason || reportUser.isPending ? 0.5 : 1 }}
          >
            <Text
              variant="bodyMedium"
              color="inverse"
              style={{
                backgroundColor: colors.brandPrimary,
                textAlign: 'center',
                paddingVertical: spacing.md,
                borderRadius: radius.pill,
                overflow: 'hidden',
              }}
            >
              {reportUser.isPending ? 'Submitting…' : 'Submit report'}
            </Text>
          </Pressable>
        </Screen>
      </Modal>
    </>
  );
}

function MessageBubble({
  message,
  isOwn,
  isRead,
}: {
  message: Message;
  isOwn: boolean;
  /** `undefined` on the other participant's own messages (no receipt is
   * ever shown on someone else's bubble) — `true`/`false` only applies to
   * the caller's own messages, and only when the partner has read
   * receipts enabled (see useThreadHeaderInfo). */
  isRead?: boolean;
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
        <Text variant="body" color={isOwn ? 'inverse' : undefined}>
          {message.body}
        </Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
          <Text
            variant="caption"
            color={isOwn ? undefined : 'secondary'}
            style={isOwn ? { color: withAlpha(colors.textInverse, 0.75) } : undefined}
          >
            {message.credits_charged} cr
          </Text>
          {message.status === 'escrowed' ? (
            <Text
              variant="caption"
              color={isOwn ? undefined : 'secondary'}
              style={isOwn ? { color: withAlpha(colors.textInverse, 0.75) } : undefined}
            >
              · awaiting reply
            </Text>
          ) : message.status === 'refunded' ? (
            <Text
              variant="caption"
              color={isOwn ? undefined : 'secondary'}
              style={isOwn ? { color: withAlpha(colors.textInverse, 0.75) } : undefined}
            >
              · refunded
            </Text>
          ) : null}
          {isOwn && isRead !== undefined ? (
            <Ionicons
              name={isRead ? 'checkmark-done' : 'checkmark'}
              size={14}
              color={withAlpha(colors.textInverse, isRead ? 1 : 0.75)}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const currentUserId = session?.user.id;

  const { data: messages, isLoading } = useThreadMessages(id);
  const sendMessage = useSendMessage();
  const markThreadRead = useMarkThreadRead();
  const [headerRefetchKey, setHeaderRefetchKey] = useState(0);
  const headerInfo = useThreadHeaderInfo(id, currentUserId, headerRefetchKey);
  const [menuVisible, setMenuVisible] = useState(false);

  const isBlocked = !!headerInfo?.blockedByMe || !!headerInfo?.blockedByPartner;

  const [body, setBody] = useState('');

  // Marks this thread read the moment it's opened — per
  // docs/00-SESSION-HANDOFF.md's unread-tracking section. Fires once per
  // mount (opening a thread from the list, or navigating back into it,
  // both remount this screen); not re-fired on every new message while
  // the thread stays open, which is an acceptable v1 gap, not a bug — the
  // badge only needs to clear when the thread is actually visited.
  useEffect(() => {
    if (!id) return;
    markThreadRead.mutate(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleSend = () => {
    if (!body.trim()) return;
    sendMessage.mutate(
      { threadId: id, body },
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
          title: headerInfo?.partnerName ?? 'Chat',
          headerRight: () =>
            headerInfo ? (
              <Pressable onPress={() => setMenuVisible(true)} hitSlop={12}>
                <Ionicons name="ellipsis-vertical" size={22} color={colors.textSecondary} />
              </Pressable>
            ) : null,
        }}
      />
      <Screen style={{ paddingHorizontal: 0 }}>
        {/* Absolute, behind everything else in this screen — see
            ChatWallpaper's own header comment for why this exists and why
            it's a tinted vector pattern rather than a WhatsApp/Telegram
            asset. */}
        <ChatWallpaper />

        {headerInfo && !headerInfo.isPayer ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <Text variant="caption" color="secondary">
              They pay for this conversation — your replies earn, they do not cost you.
            </Text>
          </View>
        ) : null}

        {headerInfo?.blockedByMe ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <Text variant="caption" color="danger">
              You blocked this contact. Unblock them from the ⋮ menu to send messages again.
            </Text>
          </View>
        ) : null}

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
              const isRead =
                isOwn && headerInfo?.partnerLastReadAt
                  ? new Date(item.created_at) <= new Date(headerInfo.partnerLastReadAt)
                  : isOwn && headerInfo?.partnerLastReadAt === null
                    ? undefined // read receipts off for the partner — no indicator at all
                    : isOwn
                      ? false
                      : undefined;
              return <MessageBubble message={item} isOwn={isOwn} isRead={isRead} />;
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

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View
            style={[
              styles.composer,
              { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
            ]}
          >
            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder={isBlocked ? 'Unblock to send a message' : 'Message…'}
              placeholderTextColor={colors.textSecondary}
              editable={!isBlocked}
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
            <Text
              variant="caption"
              color="secondary"
              onPress={sendMessage.isPending || !body.trim() || isBlocked ? undefined : handleSend}
              style={{ opacity: sendMessage.isPending || !body.trim() || isBlocked ? 0.4 : 1 }}
            >
              {sendMessage.isPending ? 'Sending…' : 'Send'}
            </Text>
          </View>
        </KeyboardAvoidingView>
      </Screen>

      {headerInfo && currentUserId ? (
        <ThreadOverflowMenu
          visible={menuVisible}
          onClose={() => setMenuVisible(false)}
          threadId={id}
          partnerId={headerInfo.partnerId}
          blockedByMe={headerInfo.blockedByMe}
          currentUserId={currentUserId}
          onBlockedChange={() => setHeaderRefetchKey((k) => k + 1)}
        />
      ) : null}
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
  backdrop: { flex: 1 },
  menu: {
    position: 'absolute',
    top: 60,
    right: 16,
    borderWidth: 1,
    minWidth: 180,
    overflow: 'hidden',
  },
});
