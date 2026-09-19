import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import * as Crypto from 'expo-crypto';

import { ActionSheet, type ActionSheetAction } from '@/components/ui/ActionSheet';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { BuyCreditModal } from '@/components/ui/BuyCreditModal';
import { ChatWallpaper } from '@/components/ui/ChatWallpaper';
import { EmojiPicker } from '@/components/chat/EmojiPicker';
import { type ForwardTarget, ForwardMessageModal } from '@/components/chat/ForwardMessageModal';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { usePhoneContactNames } from '@/lib/contacts';
import { useSession } from '@/lib/hooks/useSession';
import {
  type InsufficientCreditDetails,
  type Message,
  useDeleteMessageForEveryone,
  useDeleteMessageForMe,
  useEditMessage,
  useSendMessage,
  useThreadMessages,
} from '@/lib/queries/messages';
import { useSendGroupMessage } from '@/lib/queries/groups';
import { useReportUser } from '@/lib/queries/profile';
import { useMarkThreadRead, useSetThreadBlocked, useSetThreadMuted } from '@/lib/queries/threads';
import { ONLINE_THRESHOLD_MS } from '@/lib/lastSeen';
import { useIsOnline } from '@/lib/network';
import { type OutboxItem, useOutboxStore } from '@/lib/outboxStore';
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

/** Sender label + snippet for a reply's quoted-message block — resolved by
 * the parent (ThreadScreen) against the thread's already-loaded messages,
 * not fetched separately (every message in an open thread is already in
 * memory). `undefined` fields mean "couldn't resolve" (e.g. the original
 * was purged in a way this client no longer has it cached) rather than a
 * crash — rendered as a generic "Message unavailable" placeholder, the
 * same honest-fallback posture `deleted_for_everyone` already gets. */
export interface QuotedPreview {
  senderLabel: string;
  body: string;
  isDeleted: boolean;
}

// Swipe-right-to-reply was attempted here (a Gesture.Pan()/GestureDetector
// per bubble) and pulled back out the same day: it caused a real,
// confirmed "Maximum update depth exceeded" crash on opening any thread
// with existing messages (crash report captured via
// components/ErrorBoundary.tsx's own local logging). A gesture object
// recreated fresh on every render of every bubble inside a FlatList is a
// documented react-native-gesture-handler correctness hazard (gesture
// objects should be memoized), and this was the first place in the app
// combining that library's Gesture API with a Reanimated shared value —
// removed entirely rather than patched blind, since there was no way to
// verify a fix live before shipping again. Reply is still fully reachable
// via the selection header's icon below, which uses no gesture API at
// all. Revisit swipe-to-reply later as its own isolated, properly-tested
// follow-up if still wanted.

function MessageBubble({
  message,
  isOwn,
  isRead,
  readAt,
  quotedPreview,
  selectionMode,
  isSelected,
  onOpenActions,
  onToggleSelect,
}: {
  message: Message;
  isOwn: boolean;
  /** `undefined` on the other participant's own messages (no receipt is
   * ever shown on someone else's bubble) — `true`/`false` only applies to
   * the caller's own messages, and only when the partner has read
   * receipts enabled (see useThreadHeaderInfo). */
  isRead?: boolean;
  /** This specific message's own `read_at` — stamped once by
   * `fn_mark_thread_read` the first time the partner reads it and frozen
   * from then on, so it's a real, exact per-message timestamp (not derived
   * live from the thread's shared read cursor the way it used to be,
   * which caused every older message's shown time to jump forward to
   * match the cursor's latest value on each subsequent read — a real bug,
   * fixed in migration 20260920100000). Only ever rendered when `isRead`
   * is `true`. */
  readAt?: string | null;
  /** Set only when `message.reply_to_message_id` is non-null — see
   * QuotedPreview's own comment for how this is resolved. */
  quotedPreview?: QuotedPreview;
  /** Multi-select — while active, a tap toggles this bubble's selection
   * instead of doing nothing; long-press now enters selection mode
   * directly (WhatsApp's own model) rather than opening a popup, so every
   * message action (Reply, Forward, Delete, Edit) lives in one always-
   * discoverable place: the selection header. */
  selectionMode: boolean;
  isSelected: boolean;
  onOpenActions: (message: Message) => void;
  onToggleSelect: (messageId: string) => void;
}) {
  const { colors, spacing, radius } = useTheme();
  const isDeleted = message.deleted_for_everyone;
  const dimInverseText = isOwn ? { color: withAlpha(colors.textInverse, 0.75) } : undefined;

  return (
    <View
      style={[
        styles.bubbleRow,
        {
          justifyContent: isOwn ? 'flex-end' : 'flex-start',
          marginBottom: spacing.sm,
          backgroundColor: isSelected ? withAlpha(colors.brandPrimary, 0.12) : 'transparent',
          borderRadius: radius.card,
        },
      ]}
    >
      {selectionMode ? (
        <View style={{ justifyContent: 'center', paddingHorizontal: spacing.sm }}>
          <Ionicons
            name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
            size={22}
            color={isSelected ? colors.brandPrimary : colors.textTertiary}
          />
        </View>
      ) : null}
      <View>
        <Pressable
          onPress={selectionMode ? () => onToggleSelect(message.id) : undefined}
          onLongPress={() => onOpenActions(message)}
          style={[
            styles.bubble,
            {
              backgroundColor: isOwn ? colors.brandPrimary : colors.bgSurfaceAlt,
              borderRadius: radius.bubble,
              padding: spacing.md,
            },
          ]}
        >
          {!isDeleted && message.is_forwarded ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                marginBottom: spacing.xs,
              }}
            >
              <Ionicons
                name="arrow-redo-outline"
                size={12}
                color={isOwn ? withAlpha(colors.textInverse, 0.75) : colors.textSecondary}
              />
              <Text
                variant="caption"
                color={isOwn ? undefined : 'secondary'}
                style={[{ fontStyle: 'italic' }, dimInverseText]}
              >
                Forwarded
              </Text>
            </View>
          ) : null}
          {!isDeleted && quotedPreview ? (
            <View
              style={{
                borderLeftWidth: 3,
                borderLeftColor: isOwn ? withAlpha(colors.textInverse, 0.6) : colors.brandPrimary,
                paddingLeft: spacing.sm,
                marginBottom: spacing.xs,
              }}
            >
              <Text
                variant="caption"
                color={isOwn ? undefined : 'secondary'}
                style={[{ fontWeight: '700' }, dimInverseText]}
              >
                {quotedPreview.senderLabel}
              </Text>
              <Text
                variant="caption"
                numberOfLines={1}
                color={isOwn ? undefined : 'secondary'}
                style={[quotedPreview.isDeleted ? { fontStyle: 'italic' } : null, dimInverseText]}
              >
                {quotedPreview.body}
              </Text>
            </View>
          ) : null}
          {isDeleted ? (
            <Text
              variant="body"
              color={isOwn ? 'inverse' : 'secondary'}
              style={[{ fontStyle: 'italic' }, dimInverseText]}
            >
              This message was deleted
            </Text>
          ) : (
            <Text variant="body" color={isOwn ? 'inverse' : undefined}>
              {message.body}
            </Text>
          )}
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
            {!isDeleted ? (
              <Text
                variant="caption"
                color={isOwn ? undefined : 'secondary'}
                style={dimInverseText}
              >
                {message.credits_charged} cr
              </Text>
            ) : null}
            {!isDeleted && message.edited_at ? (
              <Text
                variant="caption"
                color={isOwn ? undefined : 'secondary'}
                style={dimInverseText}
              >
                · Edited
              </Text>
            ) : null}
            {!isDeleted && message.status === 'escrowed' ? (
              <Text
                variant="caption"
                color={isOwn ? undefined : 'secondary'}
                style={dimInverseText}
              >
                · awaiting reply
              </Text>
            ) : !isDeleted && message.status === 'refunded' ? (
              <Text
                variant="caption"
                color={isOwn ? undefined : 'secondary'}
                style={dimInverseText}
              >
                · refunded
              </Text>
            ) : null}
            <Text variant="caption" color={isOwn ? undefined : 'secondary'} style={dimInverseText}>
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

/** A message composed while offline, queued in the outbox
 * (docs/13-OFFLINE-MODE-SCOPING.md) — sends automatically the moment
 * connectivity returns (lib/outboxDrain.ts), same "clock icon, no user
 * action needed" pattern WhatsApp uses. */
function OutboxPendingBubble({ body }: { body: string }) {
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

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const currentUserId = session?.user.id;

  const { data: messages, isLoading } = useThreadMessages(id, currentUserId);
  const sendMessage = useSendMessage();
  const sendGroupMessage = useSendGroupMessage();
  const editMessage = useEditMessage();
  const deleteForMe = useDeleteMessageForMe();
  const deleteForEveryone = useDeleteMessageForEveryone();
  const markThreadRead = useMarkThreadRead();
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  // Long-press now enters selection mode directly (WhatsApp's own model —
  // see MessageBubble's header comment) instead of opening a popup; the one
  // remaining popup is this small overflow sheet for actions that don't
  // earn a permanent header icon (currently just Edit, only ever shown
  // when exactly one eligible message is selected).
  const [overflowMenuVisible, setOverflowMenuVisible] = useState(false);
  // WhatsApp-style reply — set either via the selection header's Reply icon
  // (single-select only) or by swiping a bubble right. Mutually exclusive
  // with `editingMessage`: starting one clears the other, since the
  // composer only has one "replying to X" slot.
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  // Forward — captured at the moment "Forward" is tapped (a snapshot of
  // `selectedMessages`, not a live reference) so the modal's own target-
  // picking doesn't need to keep the thread's selection state alive.
  const [forwardMessages, setForwardMessages] = useState<Message[] | null>(null);
  const [forwarding, setForwarding] = useState(false);
  // Multi-select (punch-list item 5, 2026-09-19) — "Select" in a message's
  // own long-press menu turns this on, pre-selecting that message; further
  // taps toggle other messages while it stays on. Exited via the header's
  // close button or once the last selection is toggled off.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
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
  const [pendingSend, setPendingSend] = useState<{
    body: string;
    requiredCredits: number;
    replyToMessageId?: string;
  } | null>(null);
  const { data: wallets } = useWallets(currentUserId);
  const topupBalance = walletBalance(wallets, 'topup_credit');

  const isOnline = useIsOnline();
  const outboxItems = useOutboxStore((s) =>
    s.items.filter((i) => i.target.kind === '1:1' && i.target.threadId === id),
  );

  useEffect(() => {
    if (!pendingSend || !id) return;
    if (topupBalance < pendingSend.requiredCredits) return;
    // Guards against firing a second retry while one is already in flight —
    // `pendingSend` itself only changes once the mutate call below settles
    // (in its own callbacks, not synchronously here), so without this a
    // rapid second Realtime balance tick during that window would re-enter.
    if (sendMessage.isPending) return;

    const text = pendingSend.body;
    const replyToMessageId = pendingSend.replyToMessageId;
    sendMessage.mutate(
      { threadId: id, body: text, replyToMessageId },
      {
        onSuccess: () => setPendingSend(null),
        onError: (error) => {
          if (error.code === 'insufficient_credit') {
            const details = error.details as InsufficientCreditDetails | undefined;
            setPendingSend({
              body: text,
              requiredCredits: details?.credits_required ?? pendingSend.requiredCredits,
              replyToMessageId,
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

    const replyToMessageId = replyingTo?.id;

    // Offline outbox (docs/13-OFFLINE-MODE-SCOPING.md): queue rather than
    // attempt the send — WhatsApp's own behavior is to accept the compose
    // immediately and show a pending bubble, not block or error. Editing
    // an existing message (handled above) still requires a live connection
    // regardless, since it has no queued-offline equivalent in this scope.
    if (!isOnline && currentUserId) {
      useOutboxStore.getState().enqueue({
        clientMessageId: Crypto.randomUUID(),
        body: text,
        createdAt: new Date().toISOString(),
        senderId: currentUserId,
        target: { kind: '1:1', threadId: id },
        replyToMessageId,
      });
      setBody('');
      setReplyingTo(null);
      return;
    }

    sendMessage.mutate(
      { threadId: id, body: text, replyToMessageId },
      {
        onSuccess: () => {
          setBody('');
          setReplyingTo(null);
        },
        onError: (error) => {
          if (error.code === 'insufficient_credit') {
            const details = error.details as InsufficientCreditDetails | undefined;
            setPendingSend({
              body: text,
              requiredCredits: details?.credits_required ?? 0,
              replyToMessageId,
            });
            setBody('');
            setReplyingTo(null);
          }
          // other errors: leave `body`/`replyingTo` as they were, the error
          // banner below shows it — matches the pre-existing "don't lose
          // what was typed on a real failure" posture.
        },
      },
    );
  };

  /** Starts replying to a message — reached via the selection header's
   * Reply icon (single-select only; see MessageBubble's own header comment
   * for why a swipe gesture isn't the entry point here). Cancels an
   * in-progress edit first — the two composer modes are mutually
   * exclusive — but leaves whatever the user was already typing untouched
   * otherwise, matching WhatsApp: starting a reply adds the quote context
   * above your draft, it doesn't discard it. */
  const handleReply = (message: Message) => {
    if (editingMessage) {
      setEditingMessage(null);
      setBody('');
    }
    setReplyingTo(message);
    composerInputRef.current?.focus();
  };

  const handleCancelReply = () => setReplyingTo(null);

  /** Opens the Forward target picker for the given messages — a snapshot
   * taken at tap time, not a live reference into `selectedIds`, so the
   * modal keeps working correctly even after selection mode exits. */
  const handleOpenForward = (targets: Message[]) => {
    setForwardMessages(targets);
    exitSelection();
  };

  /** Sends every message in `forwardMessages` to every picked target,
   * respecting the same online/offline branch `handleSend` uses (a forward
   * composed while offline queues exactly like a normal send) — one
   * Promise.allSettled batch rather than N awaited round trips, so a slow
   * or failing target doesn't stall the others. */
  const handleConfirmForward = async (targets: ForwardTarget[]) => {
    if (!forwardMessages || !currentUserId) return;
    setForwarding(true);

    const jobs = forwardMessages.flatMap((message) =>
      targets.map(async (target) => {
        if (!isOnline) {
          const item: OutboxItem =
            target.kind === '1:1'
              ? {
                  clientMessageId: Crypto.randomUUID(),
                  body: message.body,
                  createdAt: new Date().toISOString(),
                  senderId: currentUserId,
                  target: { kind: '1:1', threadId: target.id },
                  isForwarded: true,
                }
              : {
                  clientMessageId: Crypto.randomUUID(),
                  body: message.body,
                  createdAt: new Date().toISOString(),
                  senderId: currentUserId,
                  target: { kind: 'group', groupThreadId: target.id },
                  isForwarded: true,
                };
          useOutboxStore.getState().enqueue(item);
          return;
        }

        if (target.kind === '1:1') {
          await sendMessage.mutateAsync({
            threadId: target.id,
            body: message.body,
            isForwarded: true,
          });
        } else {
          await sendGroupMessage.mutateAsync({
            groupThreadId: target.id,
            body: message.body,
            isForwarded: true,
          });
        }
      }),
    );

    const results = await Promise.allSettled(jobs);
    setForwarding(false);
    setForwardMessages(null);

    const failures = results.filter((r) => r.status === 'rejected').length;
    if (failures > 0) {
      Alert.alert(
        'Some messages could not be forwarded',
        `${failures} of ${results.length} failed to send.`,
      );
    }
  };

  const handleCancelEdit = () => {
    setEditingMessage(null);
    setBody('');
  };

  const handleRequestEdit = (message: Message) => {
    setReplyingTo(null);
    setEditingMessage(message);
    setBody(message.body);
    setSelection({ start: message.body.length, end: message.body.length });
    composerInputRef.current?.focus();
  };

  // Long-press enters selection mode directly now (WhatsApp's own model —
  // see MessageBubble's header comment for why this replaced a per-message
  // popup): every action lives in the selection header from here on.
  const enterSelection = (messageId: string) => {
    setSelectionMode(true);
    setSelectedIds(new Set([messageId]));
  };

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // Toggling the last-selected message off exits selection mode entirely
  // — an empty "0 selected" toolbar would just be confusing dead UI.
  const toggleSelected = (messageId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
        if (next.size === 0) setSelectionMode(false);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  // A single message's delete now always goes through the same selection +
  // trash-icon path as a batch (enterSelection pre-selects just that one
  // message on long-press) — runBatchDelete below already handles n=1 and
  // n>1 identically, so there's no need for separate single-message
  // handlers anymore; the dedicated Delete-for-me/Delete-for-everyone
  // functions this replaced were removed rather than kept as unused code.
  const selectedMessages = (messages ?? []).filter((m) => selectedIds.has(m.id));
  // "Delete for everyone" only offered on a multi-select batch when every
  // selected message is the caller's own and not already a tombstone —
  // same all-or-nothing rule WhatsApp's own multi-select applies (mixing
  // in someone else's message hides the option entirely rather than
  // silently skipping it).
  const canBatchDeleteForEveryone =
    selectedMessages.length > 0 &&
    selectedMessages.every((m) => m.sender_id === currentUserId && !m.deleted_for_everyone);

  const runBatchDelete = async (mode: 'me' | 'everyone') => {
    if (!id) return;
    setBatchDeleting(true);
    const ids = [...selectedIds];
    const results = await Promise.allSettled(
      ids.map((messageId) =>
        mode === 'me'
          ? deleteForMe.mutateAsync({ threadId: id, messageId })
          : deleteForEveryone.mutateAsync({ threadId: id, messageId }),
      ),
    );
    setBatchDeleting(false);
    exitSelection();
    const failures = results.filter((r) => r.status === 'rejected').length;
    if (failures > 0) {
      Alert.alert(
        'Some messages could not be deleted',
        `${failures} of ${ids.length} failed — they may be outside the delete window or already removed.`,
      );
    }
  };

  const handleBatchDelete = () => {
    if (selectedIds.size === 0) return;
    Alert.alert(
      `Delete ${selectedIds.size} message${selectedIds.size > 1 ? 's' : ''}?`,
      undefined,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete for me', style: 'destructive', onPress: () => void runBatchDelete('me') },
        ...(canBatchDeleteForEveryone
          ? [
              {
                text: 'Delete for everyone',
                style: 'destructive' as const,
                onPress: () => void runBatchDelete('everyone'),
              },
            ]
          : []),
      ],
    );
  };

  // WhatsApp-style selection-header eligibility (every message action now
  // lives here, discoverable regardless of any one message's own state —
  // the fix for "Edit disappeared" the multi-select/delete feature
  // surfaced: Edit was always correctly hidden once a message settles
  // (docs/03-ECONOMY-LEDGER.md), the real problem was that a shifting
  // popup made that easy to miss. A persistent header with icons that only
  // enable/disable, plus one overflow for the rest, doesn't have that
  // problem).
  const canReplySelected =
    selectedMessages.length === 1 && !selectedMessages[0].deleted_for_everyone;
  const canForwardSelected =
    selectedMessages.length > 0 && selectedMessages.every((m) => !m.deleted_for_everyone);
  const canEditSelected =
    selectedMessages.length === 1 &&
    selectedMessages[0].sender_id === currentUserId &&
    selectedMessages[0].status === 'escrowed' &&
    !selectedMessages[0].deleted_for_everyone;

  const overflowActions: ActionSheetAction[] = canEditSelected
    ? [
        {
          label: 'Edit',
          onPress: () => {
            handleRequestEdit(selectedMessages[0]);
            exitSelection();
          },
        },
      ]
    : [];

  // Quoted-reply previews resolved locally — every message in an open
  // thread is already loaded in `messages`, so a reply's quote never needs
  // its own round trip. `undefined` (not found) means the original has
  // scrolled out of this query's loaded range or is otherwise unavailable;
  // MessageBubble renders that as an honest "Message unavailable" rather
  // than guessing.
  const messagesById = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);
  const getQuotedPreview = (message: Message): QuotedPreview | undefined => {
    if (!message.reply_to_message_id) return undefined;
    const original = messagesById.get(message.reply_to_message_id);
    if (!original) {
      return { senderLabel: 'Original message', body: 'Message unavailable', isDeleted: false };
    }
    return {
      senderLabel: original.sender_id === currentUserId ? 'You' : (partnerDisplayName ?? 'Them'),
      body: original.deleted_for_everyone ? 'This message was deleted' : original.body,
      isDeleted: original.deleted_for_everyone,
    };
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: selectionMode ? `${selectedIds.size} selected` : (partnerDisplayName ?? 'Chat'),
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
          // Selection-mode toolbar (punch-list item 5, 2026-09-19) swaps
          // the whole header: a close button on the left instead of the
          // native back arrow, a plain "N selected" title (falls back to
          // the `title` string above once `headerTitle` is undefined), and
          // a delete icon on the right instead of the ⋮ menu.
          headerLeft: selectionMode
            ? () => (
                <Pressable onPress={exitSelection} hitSlop={12} style={{ marginLeft: 8 }}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </Pressable>
              )
            : undefined,
          // Custom headerTitle (not just the `title` string above, which
          // still drives the OS-level back-swipe label) so the avatar can
          // render alongside the name/phone-fallback text.
          // The whole title block is tappable — opens the partner's
          // profile (name + InvolveMe About), the same screen the chat
          // list's own avatar tap already reaches, just from inside an
          // open conversation too (2026-09-18 punch-list item 12).
          headerTitle: selectionMode
            ? undefined
            : () =>
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
          // WhatsApp's own selection toolbar shape: the common actions get
          // a permanent icon (Reply/Forward/Delete), enabled or hidden
          // based on what's actually selected, and everything else
          // (currently just Edit) lives behind one overflow "⋮" — the fix
          // for "Edit is nowhere to be found" the multi-select/delete
          // feature surfaced (see the eligibility comment above
          // `overflowActions`).
          //
          // Deliberately missing: Copy. It needs a native clipboard module
          // (`expo-clipboard`/`@react-native-clipboard/clipboard`) that
          // isn't compiled into the current build — same "OTA can't ship
          // new native linkage, never build without explicit ask" rule
          // docs/13-OFFLINE-MODE-SCOPING.md already established for
          // NetInfo. Queued behind the same future native build, not
          // silently dropped.
          headerRight: selectionMode
            ? () => (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
                  {canReplySelected ? (
                    <Pressable onPress={() => handleReply(selectedMessages[0])} hitSlop={10}>
                      <Ionicons name="arrow-undo" size={21} color={colors.textSecondary} />
                    </Pressable>
                  ) : null}
                  {canForwardSelected ? (
                    <Pressable onPress={() => handleOpenForward(selectedMessages)} hitSlop={10}>
                      <Ionicons name="arrow-redo" size={21} color={colors.textSecondary} />
                    </Pressable>
                  ) : null}
                  <Pressable onPress={handleBatchDelete} hitSlop={10} disabled={batchDeleting}>
                    <Ionicons
                      name="trash-outline"
                      size={21}
                      color={batchDeleting ? colors.textTertiary : colors.textSecondary}
                    />
                  </Pressable>
                  {overflowActions.length > 0 ? (
                    <Pressable onPress={() => setOverflowMenuVisible(true)} hitSlop={10}>
                      <Ionicons name="ellipsis-vertical" size={21} color={colors.textSecondary} />
                    </Pressable>
                  ) : null}
                </View>
              )
            : () =>
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
                // `headerInfo.partnerLastReadAt === null` still means "the
                // partner has read receipts off" (see useThreadHeaderInfo)
                // — that privacy gate is preserved exactly as before. What
                // changed is the read TIME itself: previously derived live
                // from that same shared thread-wide cursor (so an older
                // message's shown time kept jumping forward to match
                // whatever the cursor's latest value was), now read
                // straight off this message's own `read_at`, stamped once
                // and frozen at the moment it was actually first read.
                const isRead = !isOwn
                  ? undefined
                  : headerInfo?.partnerLastReadAt === null
                    ? undefined
                    : !!item.read_at;
                return (
                  <MessageBubble
                    message={item}
                    isOwn={isOwn}
                    isRead={isRead}
                    readAt={item.read_at}
                    quotedPreview={getQuotedPreview(item)}
                    selectionMode={selectionMode}
                    isSelected={selectedIds.has(item.id)}
                    onOpenActions={(m) => enterSelection(m.id)}
                    onToggleSelect={toggleSelected}
                  />
                );
              }}
              ListFooterComponent={
                <>
                  {outboxItems.map((item) => (
                    <OutboxPendingBubble key={item.clientMessageId} body={item.body} />
                  ))}
                  {pendingSend ? <PendingMessageBubble body={pendingSend.body} /> : null}
                </>
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

          {replyingTo ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm,
                gap: spacing.sm,
                backgroundColor: colors.bgSurfaceAlt,
                borderLeftWidth: 3,
                borderLeftColor: colors.brandPrimary,
              }}
            >
              <Ionicons name="arrow-undo" size={16} color={colors.textSecondary} />
              <View style={{ flex: 1 }}>
                <Text variant="caption" color="secondary" style={{ fontWeight: '700' }}>
                  Replying to{' '}
                  {replyingTo.sender_id === currentUserId ? 'yourself' : partnerDisplayName}
                </Text>
                <Text variant="body" numberOfLines={1} color="secondary">
                  {replyingTo.deleted_for_everyone ? 'This message was deleted' : replyingTo.body}
                </Text>
              </View>
              <Pressable onPress={handleCancelReply} hitSlop={8}>
                <Ionicons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
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
        visible={overflowMenuVisible}
        onClose={() => setOverflowMenuVisible(false)}
        actions={overflowActions}
      />

      <ForwardMessageModal
        visible={!!forwardMessages}
        onClose={() => setForwardMessages(null)}
        currentUserId={currentUserId}
        messageCount={forwardMessages?.length ?? 0}
        onConfirm={(targets) => void handleConfirmForward(targets)}
        sending={forwarding}
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
