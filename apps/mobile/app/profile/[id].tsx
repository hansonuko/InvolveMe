import { Ionicons } from '@expo/vector-icons';
import { Contact, requestPermissionsAsync } from 'expo-contacts';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { FullScreenAvatar } from '@/components/ui/FullScreenAvatar';
import { Screen } from '@/components/ui/Screen';
import { StoryViewer } from '@/components/status/StoryViewer';
import { Text } from '@/components/ui/Text';
import { withAppLockSuppressed } from '@/lib/appLock';
import { useDeviceContacts, usePhoneContactNames } from '@/lib/contacts';
import { useContactsChangedStore } from '@/lib/contactsChangedStore';
import { useSession } from '@/lib/hooks/useSession';
import { useThreadSharedLinks } from '@/lib/queries/messages';
import { usePublicProfile, useReportUser } from '@/lib/queries/profile';
import { useStatusFeed } from '@/lib/queries/status';
import { useSetThreadBlocked, useSetThreadMuted } from '@/lib/queries/threads';
import { toE164NigerianPhone } from '@/lib/phone';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme';

const COVER_HEIGHT = 140;
const AVATAR_SIZE = 96;

const REPORT_REASONS = [
  'Spam or scam',
  'Harassment or abuse',
  'Inappropriate content',
  'Something else',
];

interface ThreadRelationInfo {
  blockedByMe: boolean;
  mutedByMe: boolean;
}

/** The caller's own block/mute state on this thread — a one-shot fetch,
 * not a TanStack Query, mirroring thread/[id].tsx's own useThreadHeaderInfo
 * (same "refetch wholesale after a mutation, via a bumped key" shape,
 * rather than keeping this live). Only fetched when a threadId is actually
 * known — an entry point with no thread yet has nothing to block/mute. */
function useThreadRelationInfo(
  threadId: string | undefined,
  currentUserId: string | undefined,
  refetchKey: number,
) {
  const [info, setInfo] = useState<ThreadRelationInfo | null>(null);

  useEffect(() => {
    if (!threadId || !currentUserId) return;
    let cancelled = false;

    (async () => {
      const { data: thread } = await supabase
        .from('threads')
        .select('participant_a, blocked_by, muted_by_a, muted_by_b')
        .eq('id', threadId)
        .maybeSingle();
      if (!thread || cancelled) return;

      const isPayer = thread.participant_a === currentUserId;
      setInfo({
        blockedByMe: thread.blocked_by === currentUserId,
        mutedByMe: isPayer ? thread.muted_by_a : thread.muted_by_b,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [threadId, currentUserId, refetchKey]);

  return info;
}

function SectionLabel({ children }: { children: string }) {
  const { spacing } = useTheme();
  return (
    <Text
      variant="caption"
      color="tertiary"
      style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.xs }}
    >
      {children}
    </Text>
  );
}

function ReportModal({
  visible,
  onClose,
  onSubmit,
  submitting,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
}) {
  const { colors, spacing, radius } = useTheme();
  const [reason, setReason] = useState<string | null>(null);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.reportCard,
            { backgroundColor: colors.bgSurface, borderRadius: radius.card },
          ]}
        >
          <Text variant="bodyMedium" style={{ padding: spacing.lg, paddingBottom: spacing.sm }}>
            Report this contact
          </Text>
          {REPORT_REASONS.map((r) => (
            <Pressable
              key={r}
              style={{
                paddingVertical: spacing.md,
                paddingHorizontal: spacing.lg,
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              onPress={() => setReason(r)}
            >
              <Text variant="body">{r}</Text>
              {reason === r ? (
                <Ionicons name="checkmark-circle" size={20} color={colors.brandPrimary} />
              ) : null}
            </Pressable>
          ))}
          <View style={{ padding: spacing.lg, gap: spacing.sm }}>
            <Button
              label={submitting ? 'Reporting…' : 'Submit report'}
              onPress={() => reason && onSubmit(reason)}
              disabled={!reason || submitting}
            />
            <Button label="Cancel" variant="secondary" onPress={onClose} disabled={submitting} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * "Save to device" (punch-list item 1, 2026-09-19) — only ever shown for
 * a contact not already saved (see ProfileScreen's own `isPhoneSaved`
 * check). The name field defaults to the profile's own self-chosen
 * `display_name` (explicitly optional to keep, per the ask — "optional
 * to use the already displayed profile name, or save with different
 * name") but is always editable before saving. Writes via `Contact.create`
 * (expo-contacts — the same module `useDeviceContacts` already reads
 * with; both `READ_CONTACTS`/`WRITE_CONTACTS` are already declared by
 * its own config plugin, confirmed by reading `withContacts.js` directly,
 * so this needed no new native permission or build). Bumps
 * `useContactsChangedStore` on success so the chat list's own
 * device-contact name resolution (chats.tsx) picks up the new name
 * immediately, per the explicit "synchronise contact with device" ask.
 */
function SaveContactModal({
  visible,
  onClose,
  phone,
  suggestedName,
}: {
  visible: boolean;
  onClose: () => void;
  phone: string;
  suggestedName: string | null;
}) {
  const { colors, spacing, radius } = useTheme();
  const bumpContactsChanged = useContactsChangedStore((s) => s.bump);
  // Initialized fresh on every open, not reset via an effect — the call
  // site below remounts this component (a `key` that flips with
  // `visible`) each time it opens, the React-docs-recommended way to
  // "reset state when [something] changes" without a setState-in-effect
  // cascade.
  const [name, setName] = useState(suggestedName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      // Same background-risk bracket useDeviceContacts.sync() already
      // documents — the OS permission dialog can fully background this
      // app on Android.
      const permission = await withAppLockSuppressed(() => requestPermissionsAsync());
      if (!permission.granted) {
        setError('Allow contacts access to save this contact.');
        return;
      }
      await Contact.create({
        givenName: name.trim(),
        phones: [{ number: `+${phone}`, label: 'mobile' }],
      });
      bumpContactsChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save contact.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[
            styles.reportCard,
            { backgroundColor: colors.bgSurface, borderRadius: radius.card },
          ]}
        >
          <Text variant="bodyMedium" style={{ padding: spacing.lg, paddingBottom: spacing.sm }}>
            Save to contacts
          </Text>
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Contact name"
              placeholderTextColor={colors.textTertiary}
              maxLength={60}
              style={{
                borderWidth: 1,
                borderColor: colors.borderSubtle,
                backgroundColor: colors.bgSurfaceAlt,
                color: colors.textPrimary,
                borderRadius: radius.card,
                paddingHorizontal: 16,
                paddingVertical: 14,
                fontSize: 17,
              }}
            />
            <Text variant="caption" color="tertiary">
              +{phone}
            </Text>
            {error ? (
              <Text variant="caption" color="danger">
                {error}
              </Text>
            ) : null}
          </View>
          <View style={{ padding: spacing.lg, gap: spacing.sm }}>
            <Button
              label={saving ? 'Saving…' : 'Save'}
              onPress={handleSave}
              disabled={!name.trim() || saving}
            />
            <Button label="Cancel" variant="secondary" onPress={onClose} disabled={saving} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Another user's profile — reached from a chat-row avatar's "Profile"
 * action or the open-thread header (see chats.tsx's ThreadRow and
 * thread/[id].tsx's headerTitle). `threadId` is an optional param: entry
 * points that already know a thread id pass it through so "Message" can
 * jump straight there and the contact-info actions (mute/block/report,
 * shared links) can render; entry points that don't have one yet just
 * don't show those, rather than guessing at one. Full WhatsApp-parity
 * contact-info layout — punch-list item 3B. */
export default function ProfileScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const currentUserId = session?.user.id;
  const { id, threadId } = useLocalSearchParams<{ id: string; threadId?: string }>();
  const { data: profile, isLoading } = usePublicProfile(id);
  const { data: sharedLinks } = useThreadSharedLinks(threadId);

  const [relationRefetchKey, setRelationRefetchKey] = useState(0);
  const relation = useThreadRelationInfo(threadId, currentUserId, relationRefetchKey);
  const setBlocked = useSetThreadBlocked();
  const setMuted = useSetThreadMuted();
  const reportUser = useReportUser();
  const [reportOpen, setReportOpen] = useState(false);
  const [avatarViewerOpen, setAvatarViewerOpen] = useState(false);
  const [statusViewerOpen, setStatusViewerOpen] = useState(false);

  // Status ring on this profile's avatar (punch-list item 6, 2026-09-19) —
  // same feed/lookup shape chats.tsx's ThreadRow already uses for the same
  // ring on a chat-list row, just keyed to this one profile instead of
  // every thread partner at once.
  const { data: statusFeed } = useStatusFeed(currentUserId);
  const statusGroup = statusFeed?.find((g) => g.poster.id === id);

  // Device-saved contact name wins over this profile's own self-chosen
  // `display_name` here too (punch-list follow-up, 2026-09-19) — the same
  // rule `chats.tsx`'s thread list and `thread/[id].tsx`'s header already
  // apply, via the same shared hook, so all three surfaces can never
  // drift apart on what name they show for the same person.
  const { resolveContactName } = usePhoneContactNames();
  const profileDisplayName = profile
    ? resolveContactName({ display_name: profile.display_name, phone: profile.phone })
    : undefined;

  // "Save to device" (punch-list item 1) — only offered when this phone
  // number isn't already saved on the device. `null` means "not checked
  // yet," deliberately distinct from `false`, so the button doesn't
  // flash on screen for a moment before the real answer comes back.
  const { sync: syncDeviceContacts } = useDeviceContacts();
  const [isPhoneSaved, setIsPhoneSaved] = useState<boolean | null>(null);
  const [saveContactOpen, setSaveContactOpen] = useState(false);

  useEffect(() => {
    if (!profile?.phone) return;
    let cancelled = false;
    (async () => {
      const deviceContacts = await syncDeviceContacts();
      if (cancelled) return;
      const saved = deviceContacts.some((c) =>
        c.phones.some((p) => toE164NigerianPhone(p).replace(/^\+/, '') === profile.phone),
      );
      setIsPhoneSaved(saved);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.phone]);

  const handleToggleMute = () => {
    if (!threadId || !relation) return;
    setMuted.mutate(
      { threadId, muted: !relation.mutedByMe },
      { onSuccess: () => setRelationRefetchKey((k) => k + 1) },
    );
  };

  const handleToggleBlock = () => {
    if (!threadId || !relation) return;
    const action = relation.blockedByMe ? 'Unblock' : 'Block';
    Alert.alert(`${action} this contact?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: action,
        style: relation.blockedByMe ? 'default' : 'destructive',
        onPress: () =>
          setBlocked.mutate(
            { threadId, blocked: !relation.blockedByMe },
            { onSuccess: () => setRelationRefetchKey((k) => k + 1) },
          ),
      },
    ]);
  };

  const handleSubmitReport = (reason: string) => {
    if (!currentUserId || !profile) return;
    reportUser.mutate(
      { reporterId: currentUserId, reportedUserId: profile.id, threadId, reason },
      {
        onSuccess: () => {
          setReportOpen(false);
          Alert.alert('Reported', 'Thanks — our team will review this.');
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Profile',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen style={{ paddingHorizontal: 0 }}>
        {isLoading ? (
          <Text variant="body" color="secondary" style={{ paddingHorizontal: spacing.lg }}>
            Loading…
          </Text>
        ) : !profile ? (
          <View style={{ alignItems: 'center', marginTop: spacing.xxl, gap: spacing.sm }}>
            <Text variant="body" color="secondary" style={{ textAlign: 'center' }}>
              This profile isn&apos;t available.
            </Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxl }}>
            <View style={[styles.cover, { backgroundColor: colors.bgSurfaceAlt }]}>
              {profile.cover_url ? (
                <Image source={{ uri: profile.cover_url }} style={StyleSheet.absoluteFill} />
              ) : null}
            </View>

            <View style={{ alignItems: 'center', marginTop: -AVATAR_SIZE / 2 }}>
              <Pressable
                // Unseen status wins the tap (there's something new to see,
                // same priority ThreadRow's own handleAvatarPress already
                // gives it) — otherwise falls back to the existing "view
                // profile photo" behavior, or does nothing with neither.
                onPress={
                  statusGroup?.hasUnseen
                    ? () => setStatusViewerOpen(true)
                    : profile.avatar_url
                      ? () => setAvatarViewerOpen(true)
                      : undefined
                }
                style={[
                  styles.avatarWrap,
                  { borderColor: colors.bgCanvas, backgroundColor: colors.bgCanvas },
                ]}
              >
                <Avatar
                  uri={profile.avatar_url}
                  displayName={profileDisplayName}
                  size={AVATAR_SIZE}
                  ringVariant={statusGroup ? (statusGroup.hasUnseen ? 'unseen' : 'seen') : 'none'}
                />
              </Pressable>
              <Text variant="title" style={{ marginTop: spacing.md }}>
                {profileDisplayName}
              </Text>
              {profile.status_text ? (
                <Text
                  variant="body"
                  color="secondary"
                  style={{
                    textAlign: 'center',
                    marginTop: spacing.xs,
                    paddingHorizontal: spacing.xl,
                  }}
                >
                  {profile.status_text}
                </Text>
              ) : null}
            </View>

            {threadId ? (
              <View style={{ alignItems: 'center', marginTop: spacing.lg }}>
                <Button
                  label="Message"
                  onPress={() => router.push(`/thread/${threadId}`)}
                  style={{ minWidth: 160 }}
                />
              </View>
            ) : null}

            {profile.phone ? (
              <View style={{ marginTop: spacing.xl }}>
                <SectionLabel>Phone</SectionLabel>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.sm,
                    gap: spacing.md,
                  }}
                >
                  <Ionicons name="call-outline" size={20} color={colors.textSecondary} />
                  <Text variant="body">+{profile.phone}</Text>
                </View>
                {isPhoneSaved === false ? (
                  <Pressable
                    onPress={() => setSaveContactOpen(true)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.sm,
                      gap: spacing.md,
                    }}
                  >
                    <Ionicons name="person-add-outline" size={20} color={colors.brandPrimary} />
                    <Text variant="body" color="brand">
                      Save to contacts
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}

            {profile.links.length > 0 ? (
              <View style={{ marginTop: spacing.lg }}>
                <SectionLabel>Links</SectionLabel>
                {profile.links.map((link, index) => (
                  <Pressable
                    key={index}
                    onPress={() => Linking.openURL(link.url)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.sm,
                      gap: spacing.md,
                    }}
                  >
                    <Ionicons name="link-outline" size={20} color={colors.textSecondary} />
                    <View style={{ flex: 1 }}>
                      <Text variant="body">{link.label}</Text>
                      <Text variant="caption" color="secondary" numberOfLines={1}>
                        {link.url}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}

            {threadId ? (
              <View style={{ marginTop: spacing.lg }}>
                <SectionLabel>Shared links</SectionLabel>
                {sharedLinks && sharedLinks.length > 0 ? (
                  sharedLinks.map((link) => (
                    <Pressable
                      key={link.messageId}
                      onPress={() => Linking.openURL(link.url)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingHorizontal: spacing.lg,
                        paddingVertical: spacing.sm,
                        gap: spacing.md,
                      }}
                    >
                      <Ionicons name="globe-outline" size={20} color={colors.textSecondary} />
                      <Text variant="body" color="secondary" numberOfLines={1} style={{ flex: 1 }}>
                        {link.url}
                      </Text>
                    </Pressable>
                  ))
                ) : (
                  <Text
                    variant="caption"
                    color="tertiary"
                    style={{ paddingHorizontal: spacing.lg }}
                  >
                    No links shared in this chat yet.
                  </Text>
                )}
                {/* Photo/video sharing has no pipeline in this app yet
                 * (docs/03-ECONOMY-LEDGER.md) — surfaced honestly instead
                 * of a media grid with nothing behind it. */}
                <Text
                  variant="caption"
                  color="tertiary"
                  style={{ paddingHorizontal: spacing.lg, marginTop: spacing.sm }}
                >
                  Photo and video sharing isn&apos;t available in chat yet.
                </Text>
              </View>
            ) : null}

            {threadId && relation ? (
              <View
                style={{
                  marginTop: spacing.xl,
                  marginHorizontal: spacing.lg,
                  borderRadius: radius.card,
                  backgroundColor: colors.bgSurface,
                  overflow: 'hidden',
                }}
              >
                <Pressable
                  onPress={handleToggleMute}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.borderSubtle,
                  }}
                >
                  <Ionicons
                    name={
                      relation.mutedByMe ? 'notifications-off-outline' : 'notifications-outline'
                    }
                    size={20}
                    color={colors.textPrimary}
                  />
                  <Text variant="body">{relation.mutedByMe ? 'Unmute' : 'Mute notifications'}</Text>
                </Pressable>
                <Pressable
                  onPress={handleToggleBlock}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.borderSubtle,
                  }}
                >
                  <Ionicons name="ban-outline" size={20} color={colors.danger} />
                  <Text variant="body" color="danger">
                    {relation.blockedByMe ? 'Unblock' : 'Block'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setReportOpen(true)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                  }}
                >
                  <Ionicons name="flag-outline" size={20} color={colors.danger} />
                  <Text variant="body" color="danger">
                    Report
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </ScrollView>
        )}
      </Screen>

      <ReportModal
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        onSubmit={handleSubmitReport}
        submitting={reportUser.isPending}
      />

      <FullScreenAvatar
        visible={avatarViewerOpen}
        uri={profile?.avatar_url}
        onClose={() => setAvatarViewerOpen(false)}
      />

      {statusViewerOpen && statusGroup ? (
        <StoryViewer
          feed={[statusGroup]}
          initialPosterIndex={0}
          currentUserId={currentUserId}
          onClose={() => setStatusViewerOpen(false)}
        />
      ) : null}

      {profile?.phone ? (
        <SaveContactModal
          key={saveContactOpen ? 'open' : 'closed'}
          visible={saveContactOpen}
          onClose={() => setSaveContactOpen(false)}
          phone={profile.phone}
          suggestedName={profile.display_name}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  cover: { height: COVER_HEIGHT, overflow: 'hidden' },
  avatarWrap: { borderRadius: 999, borderWidth: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  reportCard: { width: '100%', maxWidth: 420, alignSelf: 'center' },
});
