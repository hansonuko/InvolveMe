import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import { ActionSheet, type ActionSheetAction } from '@/components/ui/ActionSheet';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { BuyCreditModal } from '@/components/ui/BuyCreditModal';
import { ChatWallpaper } from '@/components/ui/ChatWallpaper';
import { type ForwardTarget, ForwardMessageModal } from '@/components/chat/ForwardMessageModal';
import { VoiceMessageBubble, useVoiceNoteAutoAdvance } from '@/components/chat/VoiceMessageBubble';
import { VoiceRecorderButton } from '@/components/chat/VoiceRecorderButton';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { withAppLockSuppressed } from '@/lib/appLock';
import { usePhoneContactNames } from '@/lib/contacts';
import { EdgeFunctionError } from '@/lib/edgeFunctions';
import { useSession } from '@/lib/hooks/useSession';
import {
  type InsufficientCreditDetails,
  type Message,
  useChatMediaUrl,
  useCreateChatMediaUploadUrl,
  useDeleteMessageForEveryone,
  useDeleteMessageForMe,
  useDecryptedChatImageUri,
  useEditMessage,
  useSendMessage,
  useThreadMessages,
  readLocalFileBytes,
  uploadChatAudio,
  uploadChatMedia,
  uploadEncryptedChatMedia,
} from '@/lib/queries/messages';
import { useSendGroupMessage } from '@/lib/queries/groups';
import { useReportUser } from '@/lib/queries/profile';
import {
  useEnableE2ee,
  useMarkThreadRead,
  useSetThreadBlocked,
  useSetThreadMuted,
  useSetThreadPayer,
} from '@/lib/queries/threads';
import { hexToBytes } from '@/lib/e2ee/bytes';
import { getOrCreateIdentity } from '@/lib/e2ee/identity';
import { encryptMediaBytes, type MediaKeyMaterial } from '@/lib/e2ee/mediaCrypto';
import { ensureDeviceRegistered } from '@/lib/e2ee/prekeys';
import { computeSafetyNumber } from '@/lib/e2ee/safetyNumber';
import {
  getKnownIdentityKey,
  setKnownIdentityKey,
  shouldShowE2eeNotice,
  markE2eeNoticeShown,
} from '@/lib/e2ee/safetyNumberStore';
import { nativeSodiumProvider as sodium } from '@/lib/e2ee/sodiumProviderNative';
import { ONLINE_THRESHOLD_MS } from '@/lib/lastSeen';
import { useIsOnline } from '@/lib/network';
import { type OutboxItem, useOutboxStore } from '@/lib/outboxStore';
import { useShallow } from 'zustand/react/shallow';
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
  /** Who currently pays for this thread (docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md
   * §C1, `threads.payer_id`) — `null` means nobody is, and sends are
   * rejected until someone claims the role. Deliberately NOT the same
   * thing as "am I participant_a" (see the fetch below): payer_id is a
   * separate, mutable economic role layered on the fixed participant pair. */
  payerId: string | null;
  /** docs/21-E2EE-TECHNICAL-DESIGN.md §6 — `'off'` (default, every existing
   * thread) is the unchanged plaintext path; `'active'` means every
   * message here is a Double Ratchet envelope, decrypted client-side
   * (lib/e2ee/session.ts). Never flickers back once active. */
  e2eeStatus: 'off' | 'active';
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
          'participant_a, participant_b, payer_id, e2ee_status, blocked_by, muted_by_a, muted_by_b, participant_a_last_read_at, participant_b_last_read_at',
        )
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || cancelled) return;

      // Structural only — "am I participant_a" resolves who the other
      // participant is and whose mute/read-cursor column is whose. This is
      // NOT the same question as "am I the payer" (payer_id, below), which
      // is a separate, mutable economic role — see the field's own comment
      // on ThreadHeaderInfo.
      const isParticipantA = thread.participant_a === currentUserId;
      const partnerId = isParticipantA ? thread.participant_b : thread.participant_a;
      const partnerLastReadAtRaw = isParticipantA
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
        payerId: thread.payer_id,
        e2eeStatus: thread.e2ee_status,
        blockedByMe: thread.blocked_by === currentUserId,
        blockedByPartner: !!thread.blocked_by && thread.blocked_by !== currentUserId,
        mutedByMe: isParticipantA ? thread.muted_by_a : thread.muted_by_b,
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

/** Safety-number change detection (docs/00-SESSION-HANDOFF.md session 35
 * "Next session" list, item 2) — safetyNumber.ts's fingerprint only helps
 * a user who thinks to go re-check it; this is the automatic half.
 * Compares the partner's currently-registered identity key against the
 * last one this device ever saw for them (safetyNumberStore.ts's
 * trust-on-first-use baseline) and flags a mismatch. Informational only —
 * a rotated key could be a benign re-registration or reinstall just as
 * easily as a real MITM'd exchange, and there's no way to tell which from
 * this alone, so this surfaces a dismissible banner rather than blocking
 * anything (matching Signal/WhatsApp's own "safety number changed"
 * notice). Only runs once the thread is actually e2ee-active — an 'off'
 * thread has no identity keys to compare in the first place. */
function useSafetyNumberChangeAlert(
  partnerId: string | undefined,
  e2eeStatus: 'off' | 'active' | undefined,
) {
  const [changed, setChanged] = useState(false);
  const latestKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!partnerId || e2eeStatus !== 'active') return;
    let cancelled = false;

    (async () => {
      const { data: partnerDevice } = await supabase
        .from('e2ee_devices')
        .select('identity_key_x25519')
        .eq('user_id', partnerId)
        .is('revoked_at', null)
        .limit(1)
        .maybeSingle();
      if (cancelled || !partnerDevice) return;

      const currentKey = partnerDevice.identity_key_x25519 as string;
      latestKeyRef.current = currentKey;

      const knownKey = await getKnownIdentityKey(partnerId);
      if (cancelled) return;

      if (knownKey === null) {
        // First sighting for this partner — nothing to compare against yet.
        await setKnownIdentityKey(partnerId, currentKey);
        return;
      }

      setChanged(knownKey !== currentKey);
    })();

    return () => {
      cancelled = true;
    };
  }, [partnerId, e2eeStatus]);

  /** Called once the user has seen the banner and (ideally) re-verified —
   * accepts the new key as the baseline so this stops firing until the
   * NEXT rotation, without requiring the user to prove they actually
   * compared the number (same "informational, not a hard gate" posture
   * the rest of this hook already takes). */
  const acknowledge = () => {
    if (partnerId && latestKeyRef.current) {
      setKnownIdentityKey(partnerId, latestKeyRef.current);
    }
    setChanged(false);
  };

  // Gated at read time rather than reset via a synchronous setState in the
  // effect above (that pattern trips react-hooks/set-state-in-effect) — an
  // 'off' thread or a not-yet-loaded partnerId simply never runs the fetch
  // that would set `changed` true, so masking it here is equivalent, not
  // just a lint workaround.
  return { changed: e2eeStatus === 'active' && changed, acknowledge };
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
  partnerName,
  blockedByMe,
  mutedByMe,
  currentUserId,
  e2eeStatus,
  onBlockedChange,
  onMutedChange,
  onBuyCredit,
  onE2eeStatusChange,
  openSafetyNumberRequestId,
}: {
  visible: boolean;
  onClose: () => void;
  threadId: string;
  partnerId: string;
  partnerName: string | null;
  blockedByMe: boolean;
  mutedByMe: boolean;
  currentUserId: string;
  e2eeStatus: 'off' | 'active';
  /** Called after a block/unblock mutation succeeds — useThreadHeaderInfo
   * is a one-shot fetch, not a live subscription, so the parent needs an
   * explicit nudge to re-fetch rather than picking this up automatically. */
  onBlockedChange: () => void;
  /** Same reasoning as onBlockedChange, for the mute toggle. */
  onMutedChange: () => void;
  /** docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A3 — opens the same
   * BuyCreditModal the insufficient-credit flow already uses; this menu
   * only closes itself and hands off, no new modal/state of its own. */
  onBuyCredit: () => void;
  /** Same reasoning as onBlockedChange/onMutedChange, for enabling E2EE. */
  onE2eeStatusChange: () => void;
  /** Bumped by the parent's safety-number-changed banner (useSafetyNumberChangeAlert)
   * to open this menu's own safety-number view from outside it, without
   * lifting that view's state up — undefined/0 means "no request yet", any
   * change from the previous value means "open it now". */
  openSafetyNumberRequestId?: number;
}) {
  const { colors, spacing, radius } = useTheme();
  const setBlocked = useSetThreadBlocked();
  const setMuted = useSetThreadMuted();
  const reportUser = useReportUser();
  const enableE2ee = useEnableE2ee();
  const [reportOpen, setReportOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [safetyNumberOpen, setSafetyNumberOpen] = useState(false);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [enablingE2ee, setEnablingE2ee] = useState(false);

  const handleEnableE2ee = async () => {
    onClose();
    setEnablingE2ee(true);
    try {
      await ensureDeviceRegistered();
      await enableE2ee.mutateAsync({ threadId });
      onE2eeStatusChange();
      Alert.alert(
        'Encryption enabled',
        'Messages in this conversation are now end-to-end encrypted.',
      );
    } catch (e) {
      const message =
        e instanceof EdgeFunctionError && e.code === 'partner_not_ready'
          ? "The other person hasn't set up encryption on their device yet — this will work once they have."
          : e instanceof Error
            ? e.message
            : 'Something went wrong.';
      Alert.alert('Could not enable encryption', message);
    } finally {
      setEnablingE2ee(false);
    }
  };

  const handleViewSafetyNumber = async () => {
    onClose();
    setSafetyNumberOpen(true);
    setSafetyNumber(null);
    try {
      const own = await getOrCreateIdentity();
      const { data: partnerDevice, error } = await supabase
        .from('e2ee_devices')
        .select('identity_key_x25519')
        .eq('user_id', partnerId)
        .is('revoked_at', null)
        .limit(1)
        .maybeSingle();
      if (error || !partnerDevice) throw error ?? new Error('no device on record');

      await sodium.ready();
      const number = computeSafetyNumber(
        sodium,
        { userId: currentUserId, identityKeyX25519: own.identityX25519.publicKey },
        { userId: partnerId, identityKeyX25519: hexToBytes(partnerDevice.identity_key_x25519) },
      );
      setSafetyNumber(number);
    } catch {
      setSafetyNumber('unavailable');
    }
  };

  // Opens this menu's own safety-number view from outside it (the parent's
  // safety-number-changed banner) — fires only on an actual increment, not
  // on mount, so a stale/undefined initial value never auto-opens this.
  const lastHandledSafetyNumberRequestRef = useRef(0);
  useEffect(() => {
    if (
      openSafetyNumberRequestId &&
      openSafetyNumberRequestId !== lastHandledSafetyNumberRequestRef.current
    ) {
      lastHandledSafetyNumberRequestRef.current = openSafetyNumberRequestId;
      handleViewSafetyNumber();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSafetyNumberRequestId]);

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
              onPress={() => {
                onClose();
                onBuyCredit();
              }}
            >
              <Text variant="bodyMedium" color="primary">
                Buy chat credit
              </Text>
            </Pressable>
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
            {e2eeStatus === 'off' ? (
              <Pressable
                style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.lg }}
                onPress={handleEnableE2ee}
                disabled={enablingE2ee}
              >
                <Text variant="bodyMedium" color="primary">
                  {enablingE2ee ? 'Enabling…' : 'Enable end-to-end encryption'}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                style={{ paddingVertical: spacing.md, paddingHorizontal: spacing.lg }}
                onPress={handleViewSafetyNumber}
              >
                <Text variant="bodyMedium" color="primary">
                  View safety number
                </Text>
              </Pressable>
            )}
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

      <Modal
        visible={safetyNumberOpen}
        animationType="slide"
        onRequestClose={() => setSafetyNumberOpen(false)}
      >
        <Screen>
          <View
            style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          >
            <Text variant="title">Safety number</Text>
            <Pressable onPress={() => setSafetyNumberOpen(false)} hitSlop={12}>
              <Text variant="body" color="secondary">
                Close
              </Text>
            </Pressable>
          </View>
          <View style={{ marginTop: spacing.xl, gap: spacing.md }}>
            <Text variant="body" color="secondary">
              Compare this number with {partnerName ?? 'the other person'} through a call or in
              person. If it matches on both devices, no one is intercepting this conversation.
            </Text>
            <Text variant="title" color="primary">
              {safetyNumber === null
                ? 'Loading…'
                : safetyNumber === 'unavailable'
                  ? 'Unavailable'
                  : safetyNumber}
            </Text>
          </View>
        </Screen>
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
  quotedPreview,
  selectionMode,
  isSelected,
  onOpenActions,
  onToggleSelect,
  onOpenImage,
  isE2eeThread,
}: {
  message: Message;
  isOwn: boolean;
  /** `undefined` on the other participant's own messages (no receipt is
   * ever shown on someone else's bubble) — `true`/`false` only applies to
   * the caller's own messages, and only when the partner has read
   * receipts enabled (see useThreadHeaderInfo). Still drives the single-
   * vs-double-tick icon; the "· Read <time>" text next to it was removed
   * by explicit request (2026-09-20) — the exact read timestamp is no
   * longer shown, only whether it's been read. */
  isRead?: boolean;
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
  /** Opens the full-screen viewer with this already-resolved signed URL —
   * the parent screen owns that modal's state, this bubble only ever
   * resolves its own `media_path` (via `useChatMediaUrl`, below) and hands
   * the ready URL up rather than the modal re-resolving it itself. */
  onOpenImage: (url: string) => void;
  /** This thread's current e2ee_status, passed down rather than re-derived
   * (session 37/38 media follow-up) — distinguishes "a normal plaintext
   * photo message" from "an e2ee photo message whose attachment key this
   * device couldn't recover," which look identical from `message` alone
   * once `e2eeMediaKeyBase64` is undefined in both cases. Only the second
   * case should show a "media unavailable" placeholder instead of
   * attempting to render the still-encrypted bytes directly. */
  isE2eeThread: boolean;
}) {
  const { colors, spacing, radius } = useTheme();
  const isDeleted = message.deleted_for_everyone;
  const dimInverseText = isOwn ? { color: withAlpha(colors.textInverse, 0.75) } : undefined;
  const mediaUrl = useChatMediaUrl(!isDeleted ? message.media_path : null);
  // Real end-to-end encrypted media (session 37/38) — mediaUrl above is a
  // signed URL to CIPHERTEXT when e2eeMediaKeyBase64 is set; this decrypts
  // it into a directly-renderable data: URI. For a non-e2ee message
  // (e2eeMediaKeyBase64 undefined) this hook stays disabled and
  // decryptedImageUrl.data is simply never used below — mediaUrl.data (the
  // plaintext file's own signed URL) renders directly instead, unchanged
  // from before this feature existed.
  const isE2eeImage = !isDeleted && message.media_type === 'image' && !!message.e2eeMediaKeyBase64;
  const decryptedImageUrl = useDecryptedChatImageUri(
    isE2eeImage ? mediaUrl.data : undefined,
    message.e2eeMediaKeyBase64,
    message.e2eeMediaNonceBase64,
  );
  const isE2eeMediaUnavailable =
    isE2eeThread &&
    !isDeleted &&
    message.media_type === 'image' &&
    !!message.media_path &&
    !message.e2eeMediaKeyBase64;

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
          <>
            {message.media_path && message.media_type === 'audio' ? (
              <VoiceMessageBubble
                message={message}
                isOwn={isOwn}
                threadId={message.thread_id}
                isE2eeThread={isE2eeThread}
              />
            ) : message.media_path ? (
              (() => {
                // Real end-to-end encrypted media (session 37/38): the
                // renderable image URL is either the plaintext file's own
                // signed URL (non-e2ee) or the decrypted data: URI
                // (e2ee, once decryptedImageUrl resolves) — never the raw
                // ciphertext's signed URL directly, which would just be
                // garbage bytes to <Image>.
                const displayUrl = isE2eeImage ? decryptedImageUrl.data : mediaUrl.data;
                const isBroken =
                  isE2eeMediaUnavailable || (isE2eeImage && decryptedImageUrl.isError);
                return (
                  <Pressable
                    onPress={() => displayUrl && onOpenImage(displayUrl)}
                    style={{ marginBottom: message.body?.trim() ? spacing.xs : 0 }}
                    disabled={isBroken}
                  >
                    {displayUrl ? (
                      <Image
                        source={{ uri: displayUrl }}
                        style={{ width: 220, height: 220, borderRadius: radius.card }}
                        resizeMode="cover"
                      />
                    ) : (
                      <View
                        style={{
                          width: 220,
                          height: 220,
                          borderRadius: radius.card,
                          backgroundColor: withAlpha(colors.textSecondary, 0.15),
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons
                          name={
                            isBroken || mediaUrl.isError ? 'image-outline' : 'hourglass-outline'
                          }
                          size={28}
                          color={isOwn ? withAlpha(colors.textInverse, 0.6) : colors.textTertiary}
                        />
                        {isBroken ? (
                          <Text
                            variant="caption"
                            color={isOwn ? undefined : 'secondary'}
                            style={[{ marginTop: 4 }, dimInverseText]}
                          >
                            Media unavailable
                          </Text>
                        ) : null}
                      </View>
                    )}
                  </Pressable>
                );
              })()
            ) : null}
            {message.body?.trim() ? (
              <Text variant="body" color={isOwn ? 'inverse' : undefined}>
                {message.body}
              </Text>
            ) : null}
          </>
        )}
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
          {!isDeleted ? (
            <Text variant="caption" color={isOwn ? undefined : 'secondary'} style={dimInverseText}>
              {message.credits_charged} cr
            </Text>
          ) : null}
          {!isDeleted && message.edited_at ? (
            <Text variant="caption" color={isOwn ? undefined : 'secondary'} style={dimInverseText}>
              · Edited
            </Text>
          ) : null}
          {!isDeleted && message.status === 'escrowed' ? (
            <Text variant="caption" color={isOwn ? undefined : 'secondary'} style={dimInverseText}>
              · awaiting reply
            </Text>
          ) : !isDeleted && message.status === 'refunded' ? (
            <Text variant="caption" color={isOwn ? undefined : 'secondary'} style={dimInverseText}>
              · refunded
            </Text>
          ) : null}
          <Text variant="caption" color={isOwn ? undefined : 'secondary'} style={dimInverseText}>
            {formatMessageTime(message.created_at)}
          </Text>
          {isOwn && isRead !== undefined ? (
            // docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A1 — sized
            // up from 14 (closer to WhatsApp's own tick-to-text ratio,
            // approximated — not pixel-verified against a live WhatsApp
            // build from this environment) and the double-tick turns
            // `tickRead` (a deliberate yellow, not WhatsApp's blue) once
            // read, instead of just a subtler opacity of the bubble text.
            <Ionicons
              name={isRead ? 'checkmark-done' : 'checkmark'}
              size={16}
              color={isRead ? colors.tickRead : withAlpha(colors.textInverse, 0.75)}
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

/** The current user's own message, shown the instant "send" is tapped
 * rather than waiting on a server round trip — same bubble styling as a
 * real sent message (`MessageBubble`'s own-message branch) so there's no
 * visual "downgrade then upgrade" flash once the real row swaps in, just a
 * clock icon standing in for the tick row until it does. */
function SendingMessageBubble({ body, imageUri }: { body: string; imageUri?: string }) {
  const { colors, spacing, radius } = useTheme();
  return (
    <View style={[styles.bubbleRow, { justifyContent: 'flex-end', marginBottom: spacing.sm }]}>
      <View
        style={[
          styles.bubble,
          {
            backgroundColor: colors.brandPrimary,
            borderRadius: radius.bubble,
            padding: spacing.md,
          },
        ]}
      >
        {imageUri ? (
          <Image
            source={{ uri: imageUri }}
            style={{
              width: 220,
              height: 220,
              borderRadius: radius.card,
              marginBottom: body.trim() ? spacing.xs : 0,
            }}
            resizeMode="cover"
          />
        ) : null}
        {body.trim() ? (
          <Text variant="body" color="inverse">
            {body}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.xs }}>
          <Ionicons name="time-outline" size={14} color={withAlpha(colors.textInverse, 0.75)} />
        </View>
      </View>
    </View>
  );
}

/** Full-screen tap-to-view for a chat photo — plain contain-mode Image in
 * a Modal, no pinch-zoom. Deliberately matches StoryViewer's own existing
 * full-screen photo view exactly (also a plain `resizeMode="contain"`
 * Image, no gesture handling) rather than introducing new gesture code:
 * this codebase has a documented bad experience with Reanimated/Gesture-
 * Handler here (see MessageBubble's own swipe-to-reply removal comment,
 * "removed entirely rather than patched blind... no way to verify a fix
 * live") — consistency with the one proven-working pattern beats a
 * pinch-zoom nobody can verify on-device this session either. */
function ChatImageViewerModal({
  visible,
  imageUrl,
  onClose,
}: {
  visible: boolean;
  imageUrl: string | null;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} transparent>
      <Pressable
        style={{ flex: 1, backgroundColor: '#000' }}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close photo"
      >
        {imageUrl ? (
          <Image source={{ uri: imageUrl }} style={{ flex: 1 }} resizeMode="contain" />
        ) : null}
      </Pressable>
    </Modal>
  );
}

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const currentUserId = session?.user.id;

  // Moved above useThreadMessages (its original position was further
  // below, alongside the rest of this screen's useState calls) — decrypt
  // wiring needs to know the thread's e2ee_status before fetching
  // messages, and hook call order must stay stable regardless, so this
  // just needed to move, not change in any other way.
  const [headerRefetchKey, setHeaderRefetchKey] = useState(0);
  const headerInfo = useThreadHeaderInfo(id, currentUserId, headerRefetchKey);
  const safetyNumberAlert = useSafetyNumberChangeAlert(
    headerInfo?.partnerId,
    headerInfo?.e2eeStatus,
  );
  const [safetyNumberRequestId, setSafetyNumberRequestId] = useState(0);

  // In-chat "protected" system notice (session 37) — WhatsApp-style: shown
  // once the first time a conversation is opened as e2ee-active, and again
  // after ~30 days of no notice having shown (see shouldShowE2eeNotice's
  // own header comment). Rendered in the FlatList's ListFooterComponent,
  // not ListHeaderComponent — this list always opens scrolled to the
  // bottom, so a header-position notice sat above all existing history,
  // scrolled out of view on open for any thread with real messages already
  // in it (confirmed live, session 37). Deliberately not shown at all
  // until we know the answer (`null`), so it never flashes on and off.
  const [showE2eeNotice, setShowE2eeNotice] = useState<boolean | null>(null);
  useEffect(() => {
    if (headerInfo?.e2eeStatus !== 'active') return;
    let cancelled = false;
    shouldShowE2eeNotice(id).then((show) => {
      if (cancelled) return;
      setShowE2eeNotice(show);
      if (show) markE2eeNoticeShown(id);
    });
    return () => {
      cancelled = true;
    };
  }, [id, headerInfo?.e2eeStatus]);
  // Gated at read time rather than reset via a synchronous setState in the
  // effect above (that pattern trips react-hooks/set-state-in-effect) — an
  // 'off' thread simply never runs the fetch that would set this true, so
  // masking it here is equivalent, not just a lint workaround (same
  // approach useSafetyNumberChangeAlert already takes above).
  const shouldShowE2eeNoticeNow = headerInfo?.e2eeStatus === 'active' && !!showE2eeNotice;

  // Floating payer-role icon (session 37) — replaces the old fixed banner
  // pinned above the message list. Collapsed to just the icon by default;
  // tapping reveals the current payer state + toggle action, and any
  // action taken (or a tap outside it) collapses it straight back.
  const [payerPopoverVisible, setPayerPopoverVisible] = useState(false);

  const {
    data: messages,
    isLoading,
    refetch: refetchMessages,
  } = useThreadMessages(id, currentUserId, headerInfo?.e2eeStatus);
  useVoiceNoteAutoAdvance(messages);
  const sendMessage = useSendMessage();
  const createChatMediaUploadUrl = useCreateChatMediaUploadUrl();
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
  const [menuVisible, setMenuVisible] = useState(false);
  const [buyCreditVisible, setBuyCreditVisible] = useState(false);
  const setThreadPayer = useSetThreadPayer();

  // docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §C1 — the payer banner
  // below is the only surface for this. Claiming (self) and stepping down
  // (null) both route through the same mutation; fn_set_thread_payer is
  // the actual authority on whether either is currently allowed (self-only,
  // current-payer-only stepdown, the 24h idle gate on taking over) — this
  // handler just picks which of the two to ask for and surfaces the
  // server's rejection reason rather than guessing at one client-side.
  const handleTapPayerBanner = () => {
    if (!headerInfo || !currentUserId) return;
    const iAmPayer = headerInfo.payerId === currentUserId;
    const newPayerId = iAmPayer ? null : currentUserId;

    setThreadPayer.mutate(
      { threadId: id, newPayerId },
      {
        onSuccess: () => setHeaderRefetchKey((k) => k + 1),
        onError: (error) => {
          const code = error instanceof EdgeFunctionError ? error.code : null;
          if (code === 'thread_not_idle_long_enough') {
            Alert.alert(
              'Not yet',
              'This conversation needs to be quiet for a while before you can take over paying.',
            );
            return;
          }
          Alert.alert('Could not update', error instanceof Error ? error.message : 'Try again.');
        },
      },
    );
  };

  // Ticks every 15s purely so "online" can flip to "last seen ..." from
  // time passing alone — see formatLastSeen's own comment for why this
  // can't just be derived once from `partnerLastSeenAt` changing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  // Self-healing fallback for stale presence (lib/supabase.ts's own
  // AppState handler reconnects the Realtime socket on foreground, but
  // that alone still depends on the socket successfully redelivering
  // whatever changed while backgrounded — not guaranteed, e.g. if the
  // partner's own last_seen_at update landed in the gap between
  // disconnect and reconnect). A plain refetch needs no such guarantee:
  // every foreground transition while a thread is open forces one, same
  // "next foreground event will catch up" posture lib/lastSeen.ts already
  // documents for the write side of this exact same presence system.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setHeaderRefetchKey((k) => k + 1);
    });
    return () => subscription.remove();
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
  const composerInputRef = useRef<TextInput>(null);

  // Chat media (docs/16-CHAT-MEDIA-SCOPING.md) — a picked-but-not-yet-sent
  // photo, staged in the composer exactly like `replyingTo`/`editingMessage`
  // are: a preview bar above the input, cleared on send or on explicit
  // removal. `attachSheetOpen` is the picker's own camera-vs-gallery
  // choice, a plain ActionSheet (already used elsewhere in this screen)
  // rather than a bespoke picker UI.
  const [pickedImage, setPickedImage] = useState<{ uri: string } | null>(null);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [isPickingImage, setIsPickingImage] = useState(false);
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);
  // Whether VoiceRecorderButton has left 'idle' — the composer hides the
  // text input/camera/send button and gives it the full row once true,
  // matching WhatsApp's own composer once a recording actually starts.
  const [recorderActive, setRecorderActive] = useState(false);
  // A tapped-open bubble's signed URL — MessageBubble resolves its own
  // media_path via useChatMediaUrl and hands the ready signed URL up here,
  // rather than this state holding a media_path the viewer would need to
  // re-resolve itself.
  const [viewingImageUrl, setViewingImageUrl] = useState<string | null>(null);

  /** Resize/compress to the docs/01-ARCHITECTURE.md §5 chat-image target
   * (1600px longest edge) — JPEG, not the architecture doc's aspirational
   * WebP, matching StatusComposer's own already-proven-working choice:
   * `ImageManipulator.SaveFormat.WEBP` exists in this SDK version's types,
   * but its actual cross-platform encode reliability has never been
   * confirmed live in this codebase (no device available this session
   * either) — JPEG is the verified-safe choice, not a settled-for one.
   * Same `withAppLockSuppressed` wrap StatusComposer's own picker uses,
   * for the same reason: the native camera/gallery Activity backgrounding
   * this app must not trip useAppLock's re-lock check mid-pick. */
  const pickImage = async (source: 'camera' | 'library') => {
    setAttachSheetOpen(false);
    const launch =
      source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
    setIsPickingImage(true);
    try {
      const result = await withAppLockSuppressed(() =>
        launch({ mediaTypes: 'images', quality: 0.8 }),
      );
      if (result.canceled || !result.assets?.[0]) return;

      const manipulated = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1600 } }],
        { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG },
      );
      setPickedImage({ uri: manipulated.uri });
    } finally {
      setIsPickingImage(false);
    }
  };

  // Lands the thread on its most recent message on open, and keeps it
  // stuck to the bottom as new messages arrive while the reader is
  // already down there — the two literal gaps reported: this screen used
  // to always open at the oldest message (a plain, non-inverted FlatList
  // with no initial scroll position ever set), and never followed new
  // messages in either direction. `isNearBottomRef` (not state) because
  // `onScroll` fires on every frame while dragging — routing that through
  // `setState` would re-render the whole message list on every scroll
  // tick for no reason; only `onContentSizeChange` (new content actually
  // arriving) needs to read the current value, and a ref is enough for
  // that. Deliberately doesn't force-follow a reader who has scrolled up
  // to read history — WhatsApp/Telegram/Messenger all leave an in-progress
  // scrollback undisturbed when a new message from the *other* person
  // arrives, only auto-following while already at (or very near) the
  // bottom.
  const messageListRef = useRef<FlatList<Message>>(null);
  const isNearBottomRef = useRef(true);
  const hasScrolledToInitialPositionRef = useRef(false);
  const NEAR_BOTTOM_THRESHOLD_PX = 120;

  const handleMessagesScroll = (e: {
    nativeEvent: {
      contentOffset: { y: number };
      contentSize: { height: number };
      layoutMeasurement: { height: number };
    };
  }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
    isNearBottomRef.current = distanceFromBottom < NEAR_BOTTOM_THRESHOLD_PX;
  };

  const handleMessagesContentSizeChange = () => {
    // The very first non-empty layout after opening the thread always
    // lands at the bottom regardless of `isNearBottomRef`'s default (which
    // exists for the steady-state case below, not this one) — an
    // unanimated jump, matching WhatsApp's own "just opened" behavior
    // rather than visibly animating from top to bottom on every open.
    if (!hasScrolledToInitialPositionRef.current) {
      hasScrolledToInitialPositionRef.current = true;
      messageListRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (isNearBottomRef.current) {
      messageListRef.current?.scrollToEnd({ animated: true });
    }
  };

  /** Called on every action that adds the reader's *own* content to the
   * bottom of the list (sending, or the offline outbox picking a message
   * up) — always follow those regardless of current scroll position,
   * exactly like every mainstream chat app does for your own outgoing
   * messages. */
  const scrollToLatest = () => {
    isNearBottomRef.current = true;
    requestAnimationFrame(() => messageListRef.current?.scrollToEnd({ animated: true }));
  };

  // A message that couldn't send for lack of chat credit — held locally
  // (never sent to the server, see PendingMessageBubble's own comment)
  // until useWallets' live balance update reports enough to retry.
  const [pendingSend, setPendingSend] = useState<{
    body: string;
    requiredCredits: number;
    replyToMessageId?: string;
    mediaPath?: string;
    mediaType?: string;
    /** Real end-to-end encrypted media (session 37/38) — must survive an
     * insufficient-credit retry alongside mediaPath/mediaType. Without this,
     * a retried e2ee photo/voice send would re-encrypt the envelope as a
     * bare caption string (no {text, mediaKey, mediaNonce} JSON), leaving
     * the already-uploaded, already-paid-for attachment permanently
     * undecryptable for both sender and recipient — the upload can't be
     * redone at retry time since the local file reference isn't kept
     * either, so the key generated the first time is the only copy that
     * will ever exist. */
    e2eeMediaKey?: MediaKeyMaterial;
  } | null>(null);

  // Optimistic own-message bubble for a normal online send (WhatsApp shows
  // your own message the instant you tap send, not once a round trip
  // confirms it) — `key` is a purely local render key, never sent to the
  // server. `startedAt` is a client timestamp captured the moment the send
  // begins, *not* tied to `send-message`'s own HTTP response — deliberately,
  // since Realtime's push and the Edge Function's HTTP response are two
  // independent round trips from the same server action, and either can
  // legitimately win the race. `inFlightSendLanded` below (computed during
  // render, not via an effect — direct `setState` inside an effect body is
  // this project's own lint gate, `react-hooks/set-state-in-effect`) treats
  // the send as landed the moment a matching own-message shows up in
  // `messages`, from whichever path actually delivered it first, so the
  // optimistic bubble and the real one never both render at once and there's
  // no gap where the message briefly disappears in between.
  const [inFlightSend, setInFlightSend] = useState<{
    key: string;
    body: string;
    startedAt: number;
    /** When set, landed-detection matches on this instead of body text —
     * a captionless photo's body is empty, which every other captionless
     * photo from the same sender would also match; media_path is
     * effectively unique per send, so it's the precise match when
     * available. */
    mediaPath?: string;
    /** The picked image's local file URI, shown by SendingMessageBubble
     * while the real row hasn't landed yet — never sent anywhere, purely
     * a render source. */
    localImageUri?: string;
  } | null>(null);
  // A few seconds of slack for client/server clock skew — see above; the
  // only cost of matching a hair too early/late is cosmetic (the bubble
  // swaps a moment off), never a functional bug.
  const inFlightSendLanded =
    !!inFlightSend &&
    !!messages?.some(
      (m) =>
        m.sender_id === currentUserId &&
        new Date(m.created_at).getTime() >= inFlightSend.startedAt - 5000 &&
        (inFlightSend.mediaPath
          ? m.media_path === inFlightSend.mediaPath
          : m.body === inFlightSend.body),
    );

  // Self-healing fallback (same posture as lib/lastSeen.ts and this
  // session's presence fix): if the real row somehow never shows up via
  // Realtime within a few seconds — a dropped event, not the normal case —
  // force one real refetch rather than leaving the optimistic bubble stuck
  // forever. Harmless to also fire once after an already-landed send (a
  // single redundant refetch), which is the trade this makes for not
  // needing an effect that reacts to `inFlightSendLanded` turning true —
  // the same direct-setState-in-effect problem this whole derivation was
  // restructured to avoid.
  useEffect(() => {
    if (!inFlightSend) return;
    const timeout = setTimeout(() => void refetchMessages(), 6000);
    return () => clearTimeout(timeout);
  }, [inFlightSend, refetchMessages]);
  const { data: wallets } = useWallets(currentUserId);
  const topupBalance = walletBalance(wallets, 'topup_credit');

  const isOnline = useIsOnline();
  // `useShallow` matters here, not just style: `.filter()` returns a brand
  // new array reference on every call, and Zustand's default selector
  // comparison is reference equality — without this, any store notification
  // (even for a totally unrelated thread's outbox item) would report this
  // selector as "changed" and re-render this screen. Currently latent
  // (nothing can enqueue while lib/network.ts's offline stub always
  // reports online — see docs/13-OFFLINE-MODE-SCOPING.md §5), but a real,
  // fixable instability rather than something to leave for whenever the
  // native build lands.
  const outboxItems = useOutboxStore(
    useShallow((s) => s.items.filter((i) => i.target.kind === '1:1' && i.target.threadId === id)),
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
    const mediaPath = pendingSend.mediaPath;
    const mediaType = pendingSend.mediaType;
    const mediaKey = pendingSend.e2eeMediaKey;
    const sendKey = Crypto.randomUUID();
    // Deferred one microtask out, not called directly in the effect body —
    // this project's lint gate (`react-hooks/set-state-in-effect`) flags
    // any direct, synchronous `setState` call inside an effect regardless
    // of legitimacy; a microtask still runs before `sendMessage.mutate`'s
    // own network request resolves, so the optimistic bubble still shows
    // immediately from the user's point of view.
    queueMicrotask(() =>
      setInFlightSend({ key: sendKey, body: text, startedAt: Date.now(), mediaPath }),
    );
    scrollToLatest();
    sendMessage.mutate(
      {
        threadId: id,
        body: text,
        replyToMessageId,
        mediaPath,
        mediaType,
        e2eeStatus: headerInfo?.e2eeStatus,
        partnerId: headerInfo?.partnerId,
        e2eeMediaKey: mediaKey,
      },
      {
        onSuccess: () => {
          setPendingSend(null);
        },
        onError: (error) => {
          setInFlightSend((prev) => (prev?.key === sendKey ? null : prev));
          if (error.code === 'insufficient_credit') {
            const details = error.details as InsufficientCreditDetails | undefined;
            setPendingSend({
              body: text,
              requiredCredits: details?.credits_required ?? pendingSend.requiredCredits,
              replyToMessageId,
              mediaPath,
              mediaType,
              e2eeMediaKey: mediaKey,
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

  const handleSend = async () => {
    const hasPickedMedia = !!pickedImage;
    if (!body.trim() && !hasPickedMedia) return;
    const text = body;

    if (editingMessage) {
      // Attaching/swapping media on an edit isn't supported (docs/16 §3) —
      // the attach button itself is hidden while editing, so hasPickedMedia
      // can't actually be true here; this is just the same guard other
      // edit-adjacent code paths in this file already apply defensively.
      editMessage.mutate(
        {
          threadId: id,
          messageId: editingMessage.id,
          body: text,
          e2eeStatus: headerInfo?.e2eeStatus,
          partnerId: headerInfo?.partnerId,
        },
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
    // immediately and show a pending bubble, not block or error. A photo
    // can't queue the same way (docs/16 explicitly scoped offline media
    // out — the outbox has no concept of "upload this local file once
    // reconnected," and this app's offline mode is itself still a stub
    // per the comment on `outboxItems` below) — surfaced as a real error
    // rather than silently dropping the attachment.
    if (!isOnline && currentUserId) {
      if (hasPickedMedia) {
        Alert.alert('No connection', "Photos can't be sent while offline yet.");
        return;
      }
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
      scrollToLatest();
      return;
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    let mediaKey: MediaKeyMaterial | undefined;
    const isE2eeActive = headerInfo?.e2eeStatus === 'active';
    if (hasPickedMedia) {
      setIsUploadingMedia(true);
      try {
        const { path, token } = await createChatMediaUploadUrl.mutateAsync();
        if (isE2eeActive) {
          // Real end-to-end encrypted media (session 37/38) — encrypt the
          // photo's bytes on-device before they ever leave it; the server
          // only ever sees ciphertext, same as it already only ever sees
          // ciphertext for e2ee text. The key/nonce travel to the recipient
          // inside this same send's envelope (see sendMessage.mutate below),
          // never through Storage.
          // encryptMediaBytes' sync sodium.randomBytes/aeadEncrypt calls go
          // straight to the native react-native-libsodium bindings — unlike
          // encryptForThread (session.ts), which always awaits sodium.ready()
          // first, nothing on this call path did until now. It happened to
          // work whenever some earlier action in the same app session (a
          // text send, e2ee setup) had already warmed the module up, and
          // threw "undefined is not a function" the moment media was the
          // very first e2ee crypto operation in a fresh session (real bug
          // report, voice-note send — same class of gap this file's own
          // sodiumProviderNative.ts header already documents twice over).
          await sodium.ready();
          const plaintextBytes = await readLocalFileBytes(pickedImage.uri);
          const { ciphertext, keyMaterial } = encryptMediaBytes(sodium, plaintextBytes);
          await uploadEncryptedChatMedia(ciphertext, path, token);
          mediaKey = keyMaterial;
        } else {
          await uploadChatMedia(pickedImage.uri, path, token);
        }
        mediaPath = path;
        mediaType = 'image';
      } catch (e) {
        Alert.alert(
          'Could not upload photo',
          e instanceof Error ? e.message : 'Something went wrong.',
        );
        return;
      } finally {
        setIsUploadingMedia(false);
      }
    }

    const sendKey = Crypto.randomUUID();
    setInFlightSend({
      key: sendKey,
      body: text,
      startedAt: Date.now(),
      mediaPath,
      localImageUri: pickedImage?.uri,
    });
    scrollToLatest();

    sendMessage.mutate(
      {
        threadId: id,
        body: text,
        replyToMessageId,
        mediaPath,
        mediaType,
        e2eeStatus: headerInfo?.e2eeStatus,
        partnerId: headerInfo?.partnerId,
        e2eeMediaKey: mediaKey,
      },
      {
        onSuccess: () => {
          setBody('');
          setReplyingTo(null);
          setPickedImage(null);
        },
        onError: (error) => {
          setInFlightSend((prev) => (prev?.key === sendKey ? null : prev));
          if (error.code === 'insufficient_credit') {
            const details = error.details as InsufficientCreditDetails | undefined;
            setPendingSend({
              body: text,
              requiredCredits: details?.credits_required ?? 0,
              replyToMessageId,
              mediaPath,
              mediaType,
              e2eeMediaKey: mediaKey,
            });
            setBody('');
            setReplyingTo(null);
            // The upload already succeeded and pendingSend now owns that
            // reference for its own auto-retry — nothing left for the
            // composer's own picked-image preview to hold onto.
            setPickedImage(null);
          }
          // other errors: leave `body`/`replyingTo`/`pickedImage` as they
          // were, the error banner below shows it — matches the
          // pre-existing "don't lose what was typed on a real failure"
          // posture. A media upload that already succeeded here is
          // orphaned in Storage (never referenced by any message) — an
          // acceptable, self-limiting cost (this app's own status pipeline
          // accepts the same class of orphan on delete failures), not
          // worth a cleanup call on an already-failing path.
        },
      },
    );
  };

  /** VoiceRecorderButton's onSend — a deliberately simpler sibling of
   * handleSend's own photo-upload branch (docs/17-VOICE-NOTES-SCOPING.md
   * §10): no insufficient-credit auto-retry-on-topup flow (that state
   * shape — `pendingSend` — has no room for duration/waveform without a
   * wider change than this pass scopes), just a direct error surfaced to
   * retry manually. Offline is rejected outright, matching the photo
   * pipeline's own decision (no "re-record and re-upload on reconnect"
   * concept in this app's outbox). */
  const handleSendVoiceNote = async (
    uri: string,
    durationSeconds: number,
    waveformSamples: number[],
  ) => {
    if (!isOnline) {
      Alert.alert('No connection', "Voice messages can't be sent while offline yet.");
      return;
    }

    setIsUploadingMedia(true);
    // Named per-stage, not just wrapped in one big try — a prior failure
    // here surfaced only "undefined is not a function" with no way to tell
    // which of five very different calls actually threw it. Tracked so the
    // next failure (if any) names its own stage instead of being a mystery
    // again.
    let stage = 'requesting an upload slot';
    try {
      const { path, token } = await createChatMediaUploadUrl.mutateAsync('audio');
      let mediaKey: MediaKeyMaterial | undefined;
      if (headerInfo?.e2eeStatus === 'active') {
        stage = 'encrypting the recording';
        // Same root cause as handleSend's own photo branch (see its
        // comment): encryptMediaBytes' sync sodium calls go straight to
        // the native react-native-libsodium bindings, which need
        // sodium.ready() awaited first — nothing on this path did until
        // now, and this was likely the first e2ee crypto operation this
        // app session, unlike text sends (which always go through
        // encryptForThread's own sodium.ready() first).
        await sodium.ready();
        const plaintextBytes = await readLocalFileBytes(uri);
        const { ciphertext, keyMaterial } = encryptMediaBytes(sodium, plaintextBytes);
        stage = 'uploading the encrypted recording';
        await uploadEncryptedChatMedia(ciphertext, path, token);
        mediaKey = keyMaterial;
      } else {
        stage = 'uploading the recording';
        await uploadChatAudio(uri, path, token);
      }

      stage = 'sending the message';
      await sendMessage.mutateAsync({
        threadId: id,
        body: '',
        mediaPath: path,
        mediaType: 'audio',
        durationSeconds,
        waveformSamples,
        e2eeStatus: headerInfo?.e2eeStatus,
        partnerId: headerInfo?.partnerId,
        e2eeMediaKey: mediaKey,
      });
      scrollToLatest();
    } catch (e) {
      // Session 37 — a real prior failure here surfaced only the generic
      // fallback below ("Something went wrong."), with no way to tell
      // what actually threw. Logged AND surfaced in the alert itself
      // (this whole pipeline has never been exercised on a real device
      // before, docs/17 §11) so the next failure is diagnosable instead
      // of a dead end.
      console.error(`handleSendVoiceNote failed while ${stage}:`, e);
      const fallbackDetail =
        e && typeof e === 'object' && 'message' in e && typeof e.message === 'string'
          ? e.message
          : `${typeof e} — ${JSON.stringify(e)}`;
      const message =
        e instanceof EdgeFunctionError
          ? e.message
          : e instanceof Error
            ? e.message
            : `Unrecognized error shape: ${fallbackDetail}`;
      Alert.alert('Could not send voice message', `While ${stage}: ${message}`);
    } finally {
      setIsUploadingMedia(false);
    }
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
        // A message reaching forwardMessages has already been through
        // useThreadMessages' own decrypt/fallback path, so this is never
        // actually null in practice — the type stays honest about the raw
        // possibility regardless (Message.body's own comment), so this
        // satisfies it with the same fallback text that path itself uses,
        // not a fresh, made-up string.
        const forwardBody = message.body ?? '🔒 Message unavailable';
        // The outbox has no concept of "encrypt this once actually
        // online" (outboxDrain.ts posts body/is_forwarded straight
        // through, docs/13-OFFLINE-MODE-SCOPING.md's own stub state) — a
        // pre-existing gap shared with a plain offline send into an
        // e2ee-active thread, not something this forward-specific pass
        // takes on. Failing loudly here (same "no connection" pattern the
        // media guard above already uses) beats silently queuing
        // something the drain would only reject later.
        if (!isOnline && target.kind === '1:1' && target.e2eeStatus === 'active') {
          throw new Error('e2ee_offline_forward_unsupported');
        }

        if (!isOnline) {
          const item: OutboxItem =
            target.kind === '1:1'
              ? {
                  clientMessageId: Crypto.randomUUID(),
                  body: forwardBody,
                  createdAt: new Date().toISOString(),
                  senderId: currentUserId,
                  target: { kind: '1:1', threadId: target.id },
                  isForwarded: true,
                }
              : {
                  clientMessageId: Crypto.randomUUID(),
                  body: forwardBody,
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
            body: forwardBody,
            isForwarded: true,
            e2eeStatus: target.e2eeStatus,
            partnerId: target.partnerId,
          });
        } else {
          await sendGroupMessage.mutateAsync({
            groupThreadId: target.id,
            body: forwardBody,
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
    // Never actually null in practice by the time a message is selectable
    // here (already through useThreadMessages' own decrypt/fallback path,
    // same reasoning as handleConfirmForward's forwardBody above) — the
    // type stays honest about the raw possibility regardless.
    setBody(message.body ?? '');
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
  // Media messages are excluded (docs/16-CHAT-MEDIA-SCOPING.md §2 —
  // forwarding an attachment is explicit out-of-v1-scope, not silently
  // broken): the underlying forward call only ever carries `body`, so
  // forwarding a photo today would silently drop it and forward just its
  // caption — excluding it here is the honest behavior until that's
  // actually built, not a workaround for a bug.
  const canForwardSelected =
    selectedMessages.length > 0 &&
    selectedMessages.every((m) => !m.deleted_for_everyone && !m.media_path);
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
      body: original.deleted_for_everyone
        ? 'This message was deleted'
        : original.body || (original.media_path ? '📷 Photo' : ''),
      isDeleted: original.deleted_for_everyone,
    };
  };

  const sendDisabled =
    sendMessage.isPending ||
    editMessage.isPending ||
    isUploadingMedia ||
    (!body.trim() && !pickedImage) ||
    isBlocked ||
    // headerInfo (e2eeStatus/partnerId) resolves via its own separate,
    // slower fetch than the messages list — without this, a send fired
    // before it settles goes out with e2eeStatus undefined, skipping
    // client-side encryption entirely, while the server's own e2ee_status
    // is already 'active' and requires envelopes: `e2ee_envelopes_required`
    // (session 37/38 bug report, hit fastest via a voice note, which needs
    // no typing first to give this fetch time to land, but the same race
    // exists for text/photo too — fixed once here for every send path).
    !headerInfo;

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
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
                    {/* docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md §A3
                        — same BuyCreditModal the insufficient-credit flow
                        already uses, just a second, always-available entry
                        point suggested right in the header. */}
                    <Pressable onPress={() => setBuyCreditVisible(true)} hitSlop={12}>
                      <Ionicons name="wallet-outline" size={21} color={colors.textSecondary} />
                    </Pressable>
                    <Pressable onPress={() => setMenuVisible(true)} hitSlop={12}>
                      <Ionicons name="ellipsis-vertical" size={22} color={colors.textSecondary} />
                    </Pressable>
                  </View>
                ) : null,
        }}
      />
      <Screen style={{ paddingHorizontal: 0 }} edges={['right', 'bottom', 'left']}>
        {/* Absolute, behind everything else in this screen — see
            ChatWallpaper's own header comment for why this exists and why
            it's a tinted vector pattern rather than a WhatsApp/Telegram
            asset. */}
        <ChatWallpaper />

        <KeyboardAvoidingScreen>
          {safetyNumberAlert.changed ? (
            <Pressable
              onPress={() => {
                safetyNumberAlert.acknowledge();
                setSafetyNumberRequestId((n) => n + 1);
              }}
              style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}
            >
              <Text variant="caption" color="danger">
                Your security code with {headerInfo?.partnerName ?? 'this contact'} changed. Tap to
                see more
              </Text>
            </Pressable>
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
              ref={messageListRef}
              data={messages}
              keyExtractor={(m) => m.id}
              contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.md }}
              onScroll={handleMessagesScroll}
              scrollEventThrottle={100}
              onContentSizeChange={handleMessagesContentSizeChange}
              renderItem={({ item }) => {
                const isOwn = item.sender_id === currentUserId;
                // `headerInfo.partnerLastReadAt === null` still means "the
                // partner has read receipts off" (see useThreadHeaderInfo)
                // — that privacy gate is preserved exactly as before. Drives
                // only the single-vs-double-tick icon now; the "· Read
                // <time>" text this used to also gate was removed by
                // explicit request (2026-09-20) — see MessageBubble's own
                // `isRead` doc comment.
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
                    quotedPreview={getQuotedPreview(item)}
                    selectionMode={selectionMode}
                    isSelected={selectedIds.has(item.id)}
                    onOpenActions={(m) => enterSelection(m.id)}
                    onToggleSelect={toggleSelected}
                    onOpenImage={setViewingImageUrl}
                    isE2eeThread={headerInfo?.e2eeStatus === 'active'}
                  />
                );
              }}
              ListFooterComponent={
                <>
                  {/* Session 37 — moved from ListHeaderComponent (the very
                   * top of the full message history) to here: this list
                   * always opens scrolled to the BOTTOM
                   * (handleMessagesContentSizeChange), so a header-position
                   * notice was scrolled out of view on open for any thread
                   * with real history above it — confirmed live, exactly
                   * the bug reported ("not seen anywhere" once the chat
                   * was actually opened). The footer is what's on screen
                   * the moment the chat opens instead. */}
                  {shouldShowE2eeNoticeNow ? (
                    <Pressable
                      onPress={() => setSafetyNumberRequestId((n) => n + 1)}
                      style={{ alignItems: 'center', paddingVertical: spacing.md }}
                    >
                      <View
                        style={{
                          backgroundColor: colors.bgSurfaceAlt,
                          borderRadius: radius.card,
                          paddingHorizontal: spacing.md,
                          paddingVertical: spacing.sm,
                          maxWidth: '85%',
                        }}
                      >
                        <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
                          🔒 Messages are end-to-end encrypted. Only people in this chat can read,
                          or share them. See more
                        </Text>
                      </View>
                    </Pressable>
                  ) : null}
                  {outboxItems.map((item) => (
                    <OutboxPendingBubble key={item.clientMessageId} body={item.body} />
                  ))}
                  {pendingSend ? <PendingMessageBubble body={pendingSend.body} /> : null}
                  {inFlightSend && !inFlightSendLanded ? (
                    <SendingMessageBubble
                      body={inFlightSend.body}
                      imageUri={inFlightSend.localImageUri}
                    />
                  ) : null}
                </>
              }
            />
          )}

          {/* Floating payer-role icon (session 37) — small, collapsed to
           * just an icon (same footprint as the send button) so it never
           * competes with the header or the message list for attention.
           * Tapping reveals the current payer state + toggle action;
           * taking that action (or tapping outside it) collapses it right
           * back. Replaces the old fixed banner that used to sit pinned
           * above the message list at all times. */}
          {headerInfo && currentUserId && payerPopoverVisible ? (
            // Full-screen, beneath the icon/popover in stacking order (lower
            // zIndex) so it dims nothing visually but still catches a tap
            // anywhere outside the popover to collapse it.
            <Pressable
              style={[StyleSheet.absoluteFill, { zIndex: 9, elevation: 9 }]}
              onPress={() => setPayerPopoverVisible(false)}
            />
          ) : null}

          {headerInfo && currentUserId ? (
            <View style={styles.payerFloatingContainer} pointerEvents="box-none">
              <Pressable
                onPress={() => setPayerPopoverVisible((v) => !v)}
                hitSlop={4}
                style={[
                  styles.payerFloatingButton,
                  { backgroundColor: colors.bgSurfaceAlt, borderColor: colors.borderSubtle },
                ]}
              >
                <Ionicons
                  name="cash-outline"
                  size={20}
                  color={
                    headerInfo.payerId === currentUserId
                      ? colors.brandPrimary
                      : colors.textSecondary
                  }
                />
              </Pressable>
              {payerPopoverVisible ? (
                <View
                  style={[
                    styles.payerPopover,
                    { backgroundColor: colors.bgSurfaceAlt, borderColor: colors.borderSubtle },
                  ]}
                >
                  <Text variant="caption" color="secondary">
                    {headerInfo.payerId === null
                      ? "No one's paying right now"
                      : headerInfo.payerId === currentUserId
                        ? "You're paying for this conversation"
                        : "They're paying for this conversation"}
                  </Text>
                  <Pressable
                    onPress={() => {
                      setPayerPopoverVisible(false);
                      handleTapPayerBanner();
                    }}
                    disabled={setThreadPayer.isPending}
                    style={{ paddingTop: spacing.sm }}
                  >
                    <Text variant="bodyMedium" color="brand">
                      {headerInfo.payerId === currentUserId
                        ? 'Stop paying'
                        : 'Pay for this conversation'}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}

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

          {pickedImage ? (
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
              <Image
                source={{ uri: pickedImage.uri }}
                style={{ width: 44, height: 44, borderRadius: radius.card }}
                resizeMode="cover"
              />
              <Text variant="caption" color="secondary" style={{ flex: 1 }}>
                Photo attached
              </Text>
              <Pressable onPress={() => setPickedImage(null)} hitSlop={8}>
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
            {/* Media attach (docs/16-CHAT-MEDIA-SCOPING.md) — hidden while
             * editing (attaching/swapping media on an edit isn't
             * supported, §3), already carrying a picked photo (remove it
             * via the preview bar's own close button first, matching a
             * one-photo-per-message v1 scope), or while a voice note is
             * actually being recorded (below). */}
            {!editingMessage && !pickedImage && !recorderActive ? (
              <Pressable
                onPress={isBlocked || isPickingImage ? undefined : () => setAttachSheetOpen(true)}
                disabled={isBlocked || isPickingImage}
                hitSlop={4}
                style={{ paddingBottom: 6 }}
              >
                <Ionicons name="camera-outline" size={24} color={colors.textSecondary} />
              </Pressable>
            ) : null}
            {!recorderActive ? (
              <TextInput
                ref={composerInputRef}
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
            ) : null}
            {/* Contextual mic <-> send (docs/17-VOICE-NOTES-SCOPING.md §1)
             * — VoiceRecorderButton itself renders as just the small idle
             * mic icon until a real press-and-hold starts a recording, at
             * which point it takes over the whole row (the text
             * input/camera above hide via `recorderActive`) exactly like
             * WhatsApp's own composer. Never unmounted/remounted across
             * that transition — same element in the same JSX slot either
             * way — so an in-progress recording's internal state survives
             * every phase change. */}
            {!recorderActive && (body.trim() || pickedImage || editingMessage) ? (
              <Pressable
                onPress={sendDisabled ? undefined : handleSend}
                disabled={sendDisabled}
                hitSlop={4}
                style={[
                  styles.sendButton,
                  {
                    backgroundColor: colors.brandPrimary,
                    opacity: sendDisabled ? 0.4 : 1,
                  },
                ]}
              >
                <Ionicons
                  name={editingMessage ? 'checkmark' : 'send'}
                  size={20}
                  color={colors.textInverse}
                />
              </Pressable>
            ) : (
              <VoiceRecorderButton
                onSend={handleSendVoiceNote}
                onPhaseChange={(phase) => setRecorderActive(phase !== 'idle')}
                disabled={isBlocked || isUploadingMedia || !headerInfo}
              />
            )}
          </View>
        </KeyboardAvoidingScreen>
      </Screen>

      {headerInfo && currentUserId ? (
        <ThreadOverflowMenu
          visible={menuVisible}
          onClose={() => setMenuVisible(false)}
          threadId={id}
          partnerId={headerInfo.partnerId}
          partnerName={headerInfo.partnerName}
          blockedByMe={headerInfo.blockedByMe}
          mutedByMe={headerInfo.mutedByMe}
          currentUserId={currentUserId}
          e2eeStatus={headerInfo.e2eeStatus}
          onBlockedChange={() => setHeaderRefetchKey((k) => k + 1)}
          onMutedChange={() => setHeaderRefetchKey((k) => k + 1)}
          onBuyCredit={() => setBuyCreditVisible(true)}
          onE2eeStatusChange={() => setHeaderRefetchKey((k) => k + 1)}
          openSafetyNumberRequestId={safetyNumberRequestId}
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

      <ActionSheet
        visible={attachSheetOpen}
        onClose={() => setAttachSheetOpen(false)}
        actions={[
          { label: 'Take Photo', onPress: () => void pickImage('camera') },
          { label: 'Choose from Gallery', onPress: () => void pickImage('library') },
        ]}
      />

      <ChatImageViewerModal
        visible={!!viewingImageUrl}
        imageUrl={viewingImageUrl}
        onClose={() => setViewingImageUrl(null)}
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
  // Session 37 — floating payer-role icon, top-left over the message list
  // (not fixed to the header). Same 44x44 footprint as sendButton above,
  // per the explicit "just the size of the send button" request.
  payerFloatingContainer: {
    position: 'absolute',
    top: 8,
    left: 12,
    zIndex: 10,
    elevation: 10,
  },
  payerFloatingButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  payerPopover: {
    position: 'absolute',
    top: 50,
    left: 0,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    minWidth: 220,
  },
});
