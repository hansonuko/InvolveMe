import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { ActionSheet } from '@/components/ui/ActionSheet';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { BuyCreditModal } from '@/components/ui/BuyCreditModal';
import { ChatWallpaper } from '@/components/ui/ChatWallpaper';
import { EmojiPicker } from '@/components/chat/EmojiPicker';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { usePhoneContactNames } from '@/lib/contacts';
import { useSession } from '@/lib/hooks/useSession';
import {
  type InsufficientCreditDetails,
  type Message,
  useEditMessage,
  useSendMessage,
  useThreadMessages,
} from '@/lib/queries/messages';
import { useReportUser } from '@/lib/queries/profile';
import { useMarkThreadRead, useSetThreadBlocked, useSetThreadMuted } from '@/lib/queries/threads';
import { ONLINE_THRESHOLD_MS } from '@/lib/lastSeen';
import { useRealtimeTableChanges } from '@/lib/realtimeChannel';
import { supabase } from '@/lib/supabase';
import { useWallets, walletBalance } from '@/lib/queries/wallet';
import { useTheme, withAlpha } from '@/theme';

interface ThreadHeaderInfo {
  partnerId: string;
  partnerName: string | null;
  partnerAvatarUrl: string | null;
  /** E.164 digits, no leading `+` (same storage convention as everywhere
   * else — see docs/02-DATA-MODEL.md). Shown in the header when the
   * partner has no display_name set, instead of falling back to the
   * literal word "Chat". */
  partnerPhone: string | null;
  isPayer: boolean;
  blockedByMe: boolean;
  blockedByPartner: boolean;
  /** The caller's own mute flag on this thread (docs/10-UX-REFINEMENT-BACKLOG.md
   * Batch G) — never the partner's, which the caller has no visibility into
   * and no business rendering. */
  mutedByMe: boolean;
  /** `null` if the partner has read receipts turned off — thread/[id].tsx
   * must not render a "read" indicator in that case, per the privacy
   * toggle's own contract (see lib/queries/profile.ts). */
  partnerLastReadAt: string | null;
  /** `null` if the partner has last-seen turned off, or has never been
   * seen — same "gate at the source, not at render time" contract as
   * `partnerLastReadAt` above. */
  partnerLastSeenAt: string | null;
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
          'participant_a, participant_b, blocked_by, muted_by_a, muted_by_b, participant_a_last_read_at, participant_b_last_read_at',
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
        .select(
          'display_name, avatar_url, phone, read_receipts_enabled, last_seen_at, last_seen_enabled',
        )
        .eq('id', partnerId)
        .maybeSingle();
      if (cancelled) return;

      setInfo({
        partnerId,
        partnerName: partner?.display_name ?? null,
        partnerAvatarUrl: partner?.avatar_url ?? null,
        partnerPhone: partner?.phone ?? null,
        isPayer,
        blockedByMe: thread.blocked_by === currentUserId,
        blockedByPartner: !!thread.blocked_by && thread.blocked_by !== currentUserId,
        mutedByMe: isPayer ? thread.muted_by_a : thread.muted_by_b,
        partnerLastReadAt: partner?.read_receipts_enabled ? partnerLastReadAtRaw : null,
        partnerLastSeenAt: partner?.last_seen_enabled ? (partner?.last_seen_at ?? null) : null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [threadId, currentUserId, refetchKey]);

  // Live last-seen updates while the thread stays open — a separate
  // effect from the one-shot fetch above (matching this hook's own
  // documented "refetched wholesale... an acceptable v1 simplification"
  // posture for everything else), keyed only on the partner id once it's
  // known, so it doesn't need to redo the whole thread/partner lookup.
  useRealtimeTableChanges(
    info?.partnerId ? `user-last-seen:${info.partnerId}` : undefined,
    { event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${info?.partnerId}` },
    (payload) => {
      const updated = payload.new as {
        last_seen_at: string | null;
        last_seen_enabled: boolean;
      };
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              partnerLastSeenAt: updated.last_seen_enabled ? updated.last_seen_at : null,
            }
          : prev,
      );
    },
  );

  return info;
}

/** "online" (within the heartbeat's freshness window), or "last seen
 * today at 3:45 PM" / "last seen Sep 12 at 3:45 PM" — `null` if never
 * seen or the partner has last-seen turned off (already gated to `null`
 * upstream in useThreadHeaderInfo). `now` is passed in rather than read
 * via `Date.now()` internally so the ticking effect in ThreadScreen can
 * force a re-evaluation over time, not just when `lastSeenAt` itself
 * changes (a stale "online" needs to flip to "last seen ..." purely from
 * time passing, with no new data ever arriving). */
function formatLastSeen(lastSeenAt: string | null, now: number): string | null {
  if (!lastSeenAt) return null;
  const lastSeenMs = new Date(lastSeenAt).getTime();
  if (now - lastSeenMs < ONLINE_THRESHOLD_MS) return 'online';

  const date = new Date(lastSeenAt);
  const today = new Date(now);
  const isToday =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return isToday
    ? `last seen today at ${time}`
    : `last seen ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

/** "3:45 PM" — bare time, no date, matching the format WhatsApp shows
 * under/inside each bubble (as opposed to formatThreadTimestamp's chat-list
 * version, which falls back to a date once it's not today). Used for both
 * the "sent" and "read" times shown per message (punch-list item 4,
 * 2026-09-19) — same clock format so the two read naturally side by side. */
function formatMessageTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
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
  mutedByMe,
  currentUserId,
  onBlockedChange,
  onMutedChange,
}: {
  visible: boolean;
  onClose: () => void;
  threadId: string;
  partnerId: string;
  blockedByMe: boolean;
  mutedByMe: boolean;
  currentUserId: string;
  /** Called after a block/unblock mutation succeeds — useThreadHeaderInfo
   * is a one-shot fetch, not a live subscription, so the parent needs an
   * explicit nudge to re-fetch rather than picking this up automatically. */
  onBlockedChange: () => void;
  /** Same reasoning as onBlockedChange, for the mute toggle. */
  onMutedChange: () => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const setBlocked = useSetThreadBlocked();
  const setMuted = useSetThreadMuted();
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

  const handleToggleMute = () => {
    onClose();
    setMuted.mutate({ threadId, muted: !mutedByMe }, { onSuccess: onMutedChange });
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
              onPress={handleToggleMute}
            >
              <Text variant="bodyMedium" color="primary">
                {mutedByMe ? 'Unmute notifications' : 'Mute notifications'}
              </Text>
            </Pressable>
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
  readAt,
  onRequestEdit,
}: {
  message: Message;
  isOwn: boolean;
  /** `undefined` on the other participant's own messages (no receipt is
   * ever shown on someone else's bubble) — `true`/`false` only applies to
   * the caller's own messages, and only when the partner has read
   * receipts enabled (see useThreadHeaderInfo). */
  isRead?: boolean;
  /** The partner's read cursor (headerInfo.partnerLastReadAt) — only ever
   * rendered when `isRead` is `true`, so this is the "read at" time shown
   * next to the tick (punch-list item 4, 2026-09-19: sent time next to a
   * new read-time twist on WhatsApp's own per-message time). Not an exact
   * per-message read timestamp — this app tracks one read cursor per
   * thread, not one per message, same as the tick icon above already only
   * approximates "read" as "sent before the partner's last-read cursor" —
   * so the time shown is genuinely when the partner's cursor last moved
   * past this message, which for the most recently read message is exact
   * and for older ones is the same real timestamp, just not necessarily
   * the instant that specific message scrolled into view. */
  readAt?: string | null;
  /** Only ever called for a message that's actually editable (own,
   * still `status: 'escrowed'`) — see the long-press wiring below, which
   * only attaches this handler at all when that's true. The real edit
   * window is still enforced server-side regardless (fn_edit_message);
   * this is a UX affordance, not the safety net. */
  onRequestEdit?: (message: Message) => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const isEditable = isOwn && message.status === 'escrowed';

  return (
    <View
      style={[
        styles.bubbleRow,
        { justifyContent: isOwn ? 'flex-end' : 'flex-start', marginBottom: spacing.sm },
      ]}
    >
      <Pressable
        onLongPress={isEditable ? () => onRequestEdit?.(message) : undefined}
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
          {message.edited_at ? (
            <Text
              variant="caption"
              color={isOwn ? undefined : 'secondary'}
              style={isOwn ? { color: withAlpha(colors.textInverse, 0.75) } : undefined}
            >
              · Edited
            </Text>
          ) : null}
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
          <Text
            variant="caption"
            color={isOwn ? undefined : 'secondary'}
            style={isOwn ? { color: withAlpha(colors.textInverse, 0.75) } : undefined}
          >
            {formatMessageTime(message.created_at)}
            {isOwn && isRead && readAt ? ` · Read ${formatMessageTime(readAt)}` : ''}
          </Text>
          {isOwn && isRead !== undefined ? (
            <Ionicons
              name={isRead ? 'checkmark-done' : 'checkmark'}
              size={14}
              color={withAlpha(colors.textInverse, isRead ? 1 : 0.75)}
            />
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

/** A message held locally because the sender didn't have enough chat
 * credit — never sent to the server (CLAUDE.md rule #1: no financial
 * logic, and no new server-side "pending send" surface either), just
 * shown so the typed text isn't lost while the real send auto-retries
 * once the wallet's Realtime balance update reports enough credit. */
function PendingMessageBubble({ body }: { body: string }) {
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
        <Text variant="caption" color="secondary" style={{ marginTop: spacing.xs }}>
          Pending — will send once you buy credit
        </Text>
      </View>
    </View>
  );
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const currentUserId = session?.user.id;

  const { data: messages, isLoading } = useThreadMessages(id);
  const sendMessage = useSendMessage();
  const editMessage = useEditMessage();
  const markThreadRead = useMarkThreadRead();
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [editSheetMessage, setEditSheetMessage] = useState<Message | null>(null);
  const [headerRefetchKey, setHeaderRefetchKey] = useState(0);
  const headerInfo = useThreadHeaderInfo(id, currentUserId, headerRefetchKey);
  const [menuVisible, setMenuVisible] = useState(false);
  const [buyCreditVisible, setBuyCreditVisible] = useState(false);

  // Ticks every 15s purely so "online" can flip to "last seen ..." from
  // time passing alone — see formatLastSeen's own comment for why this
  // can't just be derived once from `partnerLastSeenAt` changing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);
  const lastSeenText = headerInfo ? formatLastSeen(headerInfo.partnerLastSeenAt, now) : null;

  // Device-saved contact name wins over the partner's own self-chosen
  // profile name here too (punch-list follow-up, 2026-09-19) — same rule
  // `chats.tsx`'s thread list already applies, via the shared
  // `usePhoneContactNames` hook so both screens can never drift apart.
  const { resolveContactName } = usePhoneContactNames();
  const partnerDisplayName = headerInfo
    ? resolveContactName({
        display_name: headerInfo.partnerName,
        phone: headerInfo.partnerPhone,
      })
    : undefined;

  const isBlocked = !!headerInfo?.blockedByMe || !!headerInfo?.blockedByPartner;

  const [body, setBody] = useState('');
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const composerInputRef = useRef<TextInput>(null);

  // Insert at the tracked cursor position, not always at the end — a
  // plain append would silently relocate an emoji away from where the
  // user was actually typing whenever they'd moved the cursor first.
  const insertEmoji = (emoji: string) => {
    setBody((prev) => prev.slice(0, selection.start) + emoji + prev.slice(selection.end));
    const nextPos = selection.start + emoji.length;
    setSelection({ start: nextPos, end: nextPos });
  };

  // The emoji panel's own backspace key — deletes one character (a
  // single emoji is usually more than one UTF-16 code unit, but Array.from
  // splits on whole Unicode code points, so this removes exactly one
  // visible character/emoji, not half of one, the same class of bug a
  // naive `.slice(0, -1)` would have).
  const handleEmojiBackspace = () => {
    setBody((prev) => {
      if (selection.start === 0 && selection.start === selection.end) return prev;
      const before = prev.slice(0, selection.end);
      const chars = Array.from(before);
      chars.pop();
      const newBefore = chars.join('');
      const removed = before.length - newBefore.length;
      const nextPos = selection.end - removed;
      setSelection({ start: nextPos, end: nextPos });
      return newBefore + prev.slice(selection.end);
    });
  };

  const toggleEmojiPicker = () => {
    if (showEmojiPicker) {
      setShowEmojiPicker(false);
      composerInputRef.current?.focus();
    } else {
      Keyboard.dismiss();
      setShowEmojiPicker(true);
    }
  };

  // A message that couldn't send for lack of chat credit — held locally
  // (never sent to the server, see PendingMessageBubble's own comment)
  // until useWallets' live balance update reports enough to retry.
  const [pendingSend, setPendingSend] = useState<{ body: string; requiredCredits: number } | null>(
    null,
  );
  const { data: wallets } = useWallets(currentUserId);
  const topupBalance = walletBalance(wallets, 'topup_credit');

  useEffect(() => {
    if (!pendingSend || !id) return;
    if (topupBalance < pendingSend.requiredCredits) return;
    // Guards against firing a second retry while one is already in flight —
    // `pendingSend` itself only changes once the mutate call below settles
    // (in its own callbacks, not synchronously here), so without this a
    // rapid second Realtime balance tick during that window would re-enter.
    if (sendMessage.isPending) return;

    const text = pendingSend.body;
    sendMessage.mutate(
      { threadId: id, body: text },
      {
        onSuccess: () => setPendingSend(null),
        onError: (error) => {
          if (error.code === 'insufficient_credit') {
            const details = error.details as InsufficientCreditDetails | undefined;
            setPendingSend({
              body: text,
              requiredCredits: details?.credits_required ?? pendingSend.requiredCredits,
            });
          } else {
            setPendingSend(null); // a different failure — don't keep silently retrying
          }
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topupBalance, pendingSend?.body, pendingSend?.requiredCredits, id, sendMessage.isPending]);

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
    const text = body;

    if (editingMessage) {
      editMessage.mutate(
        { threadId: id, messageId: editingMessage.id, body: text },
        {
          onSuccess: () => {
            setBody('');
            setEditingMessage(null);
          },
          onError: (error) => {
            // Edits never re-charge, so there's no insufficient_credit case
            // to special-case here the way a fresh send has — every real
            // failure (edit_would_increase_cost, message_not_editable,
            // edit_window_expired, content_blocked) is best surfaced
            // directly rather than silently retried.
            Alert.alert('Could not save edit', error.message);
          },
        },
      );
      return;
    }

    sendMessage.mutate(
      { threadId: id, body: text },
      {
        onSuccess: () => setBody(''),
        onError: (error) => {
          if (error.code === 'insufficient_credit') {
            const details = error.details as InsufficientCreditDetails | undefined;
            setPendingSend({ body: text, requiredCredits: details?.credits_required ?? 0 });
            setBody('');
          }
          // other errors: leave `body` as typed, the error banner below shows it
        },
      },
    );
  };

  const handleCancelEdit = () => {
    setEditingMessage(null);
    setBody('');
  };

  const handleRequestEdit = (message: Message) => {
    setEditingMessage(message);
    setBody(message.body);
    setSelection({ start: message.body.length, end: message.body.length });
    composerInputRef.current?.focus();
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: partnerDisplayName ?? 'Chat',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
          // Custom headerTitle (not just the `title` string above, which
          // still drives the OS-level back-swipe label) so the avatar can
          // render alongside the name/phone-fallback text.
          // The whole title block is tappable — opens the partner's
          // profile (name + InvolveMe About), the same screen the chat
          // list's own avatar tap already reaches, just from inside an
          // open conversation too (2026-09-18 punch-list item 12).
          headerTitle: () =>
            headerInfo ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/profile/[id]',
                    params: { id: headerInfo.partnerId, threadId: id },
                  })
                }
                hitSlop={8}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
              >
                <Avatar
                  uri={headerInfo.partnerAvatarUrl}
                  displayName={partnerDisplayName}
                  size={32}
                />
                <View>
                  <Text variant="bodyMedium" numberOfLines={1} style={{ maxWidth: 160 }}>
                    {partnerDisplayName ?? 'Chat'}
                  </Text>
                  {lastSeenText ? (
                    <Text
                      variant="caption"
                      color="tertiary"
                      numberOfLines={1}
                      style={{ maxWidth: 160 }}
                    >
                      {lastSeenText}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            ) : (
              <Text variant="bodyMedium">Chat</Text>
            ),
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

        <KeyboardAvoidingScreen>
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
                return (
                  <MessageBubble
                    message={item}
                    isOwn={isOwn}
                    isRead={isRead}
                    readAt={headerInfo?.partnerLastReadAt}
                    onRequestEdit={setEditSheetMessage}
                  />
                );
              }}
              ListFooterComponent={
                pendingSend ? <PendingMessageBubble body={pendingSend.body} /> : null
              }
            />
          )}

          {pendingSend ? (
            <View
              style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.sm }}
            >
              <Text variant="caption" color="secondary">
                Buy chat credit to start your conversation — your message will send automatically
                once it lands.
              </Text>
              <Button label="Buy credit" onPress={() => setBuyCreditVisible(true)} />
            </View>
          ) : sendMessage.isError ? (
            <View style={{ paddingHorizontal: spacing.lg }}>
              <Text variant="caption" color="danger">
                {sendMessage.error.message}
              </Text>
            </View>
          ) : null}

          {editingMessage ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm,
                gap: spacing.sm,
                backgroundColor: colors.bgSurfaceAlt,
              }}
            >
              <Ionicons name="pencil" size={16} color={colors.textSecondary} />
              <View style={{ flex: 1 }}>
                <Text variant="caption" color="secondary">
                  Editing message
                </Text>
                <Text variant="body" numberOfLines={1}>
                  {editingMessage.body}
                </Text>
              </View>
              <Pressable onPress={handleCancelEdit} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
          ) : null}

          <View
            style={[
              styles.composer,
              { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
            ]}
          >
            <Pressable
              onPress={isBlocked ? undefined : toggleEmojiPicker}
              disabled={isBlocked}
              hitSlop={4}
              style={{ paddingBottom: 6 }}
            >
              <Ionicons
                name={showEmojiPicker ? 'keypad-outline' : 'happy-outline'}
                size={24}
                color={colors.textSecondary}
              />
            </Pressable>
            <TextInput
              ref={composerInputRef}
              value={body}
              onChangeText={setBody}
              onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
              onFocus={() => setShowEmojiPicker(false)}
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
            <Pressable
              onPress={
                sendMessage.isPending || editMessage.isPending || !body.trim() || isBlocked
                  ? undefined
                  : handleSend
              }
              disabled={sendMessage.isPending || editMessage.isPending || !body.trim() || isBlocked}
              hitSlop={4}
              style={[
                styles.sendButton,
                {
                  backgroundColor: colors.brandPrimary,
                  opacity:
                    sendMessage.isPending || editMessage.isPending || !body.trim() || isBlocked
                      ? 0.4
                      : 1,
                },
              ]}
            >
              <Ionicons
                name={editingMessage ? 'checkmark' : 'send'}
                size={20}
                color={colors.textInverse}
              />
            </Pressable>
          </View>

          {showEmojiPicker ? (
            <EmojiPicker onSelectEmoji={insertEmoji} onBackspace={handleEmojiBackspace} />
          ) : null}
        </KeyboardAvoidingScreen>
      </Screen>

      {headerInfo && currentUserId ? (
        <ThreadOverflowMenu
          visible={menuVisible}
          onClose={() => setMenuVisible(false)}
          threadId={id}
          partnerId={headerInfo.partnerId}
          blockedByMe={headerInfo.blockedByMe}
          mutedByMe={headerInfo.mutedByMe}
          currentUserId={currentUserId}
          onBlockedChange={() => setHeaderRefetchKey((k) => k + 1)}
          onMutedChange={() => setHeaderRefetchKey((k) => k + 1)}
        />
      ) : null}

      <BuyCreditModal visible={buyCreditVisible} onClose={() => setBuyCreditVisible(false)} />

      <ActionSheet
        visible={!!editSheetMessage}
        onClose={() => setEditSheetMessage(null)}
        actions={
          editSheetMessage
            ? [{ label: 'Edit', onPress: () => handleRequestEdit(editSheetMessage) }]
            : []
        }
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
    fontSize: 17, // matches typography.body — punch-list item 4, 2026-09-19
    maxHeight: 120,
  },
  // 44x44 minimum tap target per docs/04-DESIGN-SYSTEM.md §6 — the old
  // bare-text "Send" pressable had no explicit sizing at all.
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
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
