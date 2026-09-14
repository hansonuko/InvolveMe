import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { type Message, useSendMessage, useThreadMessages } from '@/lib/queries/messages';
import { useMarkThreadRead } from '@/lib/queries/threads';
import { supabase } from '@/lib/supabase';
import { useTheme, withAlpha } from '@/theme';

interface ThreadHeaderInfo {
  partnerName: string | null;
  isPayer: boolean;
}

/** Just enough to render a title and know whether the current user is the
 * thread's payer (participant_a) — determines the "you're not the one
 * being charged" note on the composer, per docs/03-ECONOMY-LEDGER.md §2's
 * "A is always the paying party" rule. Fetched directly, not through a
 * TanStack Query hook — a one-shot lookup on mount is enough here, no
 * realtime need for a thread's own metadata. */
function useThreadHeaderInfo(threadId: string | undefined, currentUserId: string | undefined) {
  const [info, setInfo] = useState<ThreadHeaderInfo | null>(null);

  useEffect(() => {
    if (!threadId || !currentUserId) return;
    let cancelled = false;

    (async () => {
      const { data: thread } = await supabase
        .from('threads')
        .select('participant_a, participant_b')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || cancelled) return;

      const isPayer = thread.participant_a === currentUserId;
      const partnerId = isPayer ? thread.participant_b : thread.participant_a;

      const { data: partner } = await supabase
        .from('users')
        .select('display_name')
        .eq('id', partnerId)
        .maybeSingle();
      if (cancelled) return;

      setInfo({ partnerName: partner?.display_name ?? null, isPayer });
    })();

    return () => {
      cancelled = true;
    };
  }, [threadId, currentUserId]);

  return info;
}

function MessageBubble({ message, isOwn }: { message: Message; isOwn: boolean }) {
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
  const headerInfo = useThreadHeaderInfo(id, currentUserId);

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
      <Stack.Screen options={{ headerShown: true, title: headerInfo?.partnerName ?? 'Chat' }} />
      <Screen style={{ paddingHorizontal: 0 }}>
        {headerInfo && !headerInfo.isPayer ? (
          <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
            <Text variant="caption" color="secondary">
              They pay for this conversation — your replies earn, they do not cost you.
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
            renderItem={({ item }) => (
              <MessageBubble message={item} isOwn={item.sender_id === currentUserId} />
            )}
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
            <Text
              variant="caption"
              color="secondary"
              onPress={sendMessage.isPending || !body.trim() ? undefined : handleSend}
              style={{ opacity: sendMessage.isPending || !body.trim() ? 0.4 : 1 }}
            >
              {sendMessage.isPending ? 'Sending…' : 'Send'}
            </Text>
          </View>
        </KeyboardAvoidingView>
      </Screen>
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
});
