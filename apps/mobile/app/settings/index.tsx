import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Modal, Pressable, Switch, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { shareInvite } from '@/lib/invite';
import { useKycTier, useSubmitKyc } from '@/lib/queries/kyc';
import { useSetPushEnabled, usePushEnabled } from '@/lib/queries/notifications';
import {
  useAccountDeletionRequest,
  useProfile,
  useReportUser,
  useRequestAccountDeletion,
  useSetLastSeenEnabled,
  useSetReadReceiptsEnabled,
  useUpdateProfile,
} from '@/lib/queries/profile';
import { useBlockedThreads, useSetThreadBlocked } from '@/lib/queries/threads';
import { unregisterPushToken } from '@/lib/push';
import { supabase } from '@/lib/supabase';
import { useTheme, type ThemePreference } from '@/theme';

function KycSection() {
  const { colors, spacing, radius } = useTheme();
  const { session } = useSession();
  const { data: kycTier, isLoading } = useKycTier(session?.user.id);
  const submitKyc = useSubmitKyc();

  const [idType, setIdType] = useState<'bvn' | 'nin'>('bvn');
  const [number, setNumber] = useState('');

  const handleSubmit = () => {
    submitKyc.mutate({ type: idType, number });
  };

  if (isLoading) {
    return null;
  }

  if ((kycTier ?? 0) >= 1) {
    return (
      <View style={{ gap: spacing.sm }}>
        <Text variant="bodyMedium" color="success">
          Verified ✓
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <Text variant="caption" color="tertiary">
        Required before you can withdraw. Uses your BVN or NIN — no camera, no photos.
      </Text>

      {submitKyc.isSuccess ? (
        <Text variant="bodyMedium" color="success">
          Verified ✓
        </Text>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button
              label="BVN"
              variant={idType === 'bvn' ? 'primary' : 'secondary'}
              onPress={() => setIdType('bvn')}
            />
            <Button
              label="NIN"
              variant={idType === 'nin' ? 'primary' : 'secondary'}
              onPress={() => setIdType('nin')}
            />
          </View>
          <TextInput
            value={number}
            onChangeText={setNumber}
            placeholder={`Your ${idType.toUpperCase()} (11 digits)`}
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            maxLength={11}
            style={{
              borderWidth: 1,
              borderColor: colors.borderSubtle,
              backgroundColor: colors.bgSurfaceAlt,
              color: colors.textPrimary,
              borderRadius: radius.card,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
            }}
          />
          {submitKyc.isError ? (
            <Text variant="caption" color="danger">
              {submitKyc.error.message}
            </Text>
          ) : null}
          <Button
            label={submitKyc.isPending ? 'Verifying…' : 'Verify'}
            onPress={handleSubmit}
            disabled={submitKyc.isPending || number.length !== 11}
          />
        </>
      )}
    </View>
  );
}

/** One tappable settings row — label + optional current-value preview +
 * chevron, or a trailing custom control (a Switch) instead of the
 * chevron when `right` is given. The one primitive every section below
 * is built from, so the whole screen reads as one consistent list
 * rather than each section inventing its own row style. */
function SettingsRow({
  label,
  value,
  onPress,
  right,
  destructive,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  right?: React.ReactNode;
  destructive?: boolean;
}) {
  const { colors, spacing } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingVertical: spacing.md,
          backgroundColor: pressed && onPress ? colors.bgSurfaceAlt : 'transparent',
        },
      ]}
    >
      <Text variant="body" color={destructive ? 'danger' : 'primary'}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {value ? (
          <Text variant="body" color="tertiary" numberOfLines={1} style={{ maxWidth: 180 }}>
            {value}
          </Text>
        ) : null}
        {right ?? (onPress ? <Text color="tertiary">›</Text> : null)}
      </View>
    </Pressable>
  );
}

const THEME_PREFERENCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** System / Light / Dark — same radio-row pattern `ReportUserModal`'s
 * reason picker already establishes in this file, reused here rather than
 * inventing a second selector style for one more three-way choice. */
function AppearanceSection() {
  const { preference, setPreference, spacing } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      {THEME_PREFERENCE_OPTIONS.map((option) => (
        <Pressable
          key={option.value}
          onPress={() => setPreference(option.value)}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            paddingVertical: spacing.xs,
          }}
        >
          <Text color={preference === option.value ? 'secondary' : 'tertiary'}>
            {preference === option.value ? '●' : '○'}
          </Text>
          <Text variant="body">{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function SectionHeader({ label }: { label: string }) {
  const { spacing } = useTheme();
  return (
    <Text
      variant="caption"
      color="tertiary"
      style={{ marginTop: spacing.xl, marginBottom: spacing.xs, textTransform: 'uppercase' }}
    >
      {label}
    </Text>
  );
}

/** Name + "About" text — both already client-updatable columns (see
 * lib/queries/profile.ts). Avatar upload isn't here — deferred, needs a
 * Storage bucket this app doesn't have yet for any media type. */
function EditProfileModal({
  visible,
  onClose,
  userId,
  currentName,
  currentStatus,
}: {
  visible: boolean;
  onClose: () => void;
  userId: string;
  currentName: string | null;
  currentStatus: string | null;
}) {
  const { colors, spacing, radius } = useTheme();
  const updateProfile = useUpdateProfile();
  const [name, setName] = useState(currentName ?? '');
  const [status, setStatus] = useState(currentStatus ?? '');

  const handleSave = () => {
    updateProfile.mutate(
      { userId, displayName: name.trim(), statusText: status.trim() },
      { onSuccess: onClose },
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Edit profile</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
          <Text variant="caption" color="tertiary">
            Name
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your name"
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
              fontSize: 16,
            }}
          />
          <Text variant="caption" color="tertiary">
            About
          </Text>
          <TextInput
            value={status}
            onChangeText={setStatus}
            placeholder="Hey there! I'm using InvolveMe"
            placeholderTextColor={colors.textTertiary}
            maxLength={120}
            style={{
              borderWidth: 1,
              borderColor: colors.borderSubtle,
              backgroundColor: colors.bgSurfaceAlt,
              color: colors.textPrimary,
              borderRadius: radius.card,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
            }}
          />
          {updateProfile.isError ? (
            <Text variant="caption" color="danger">
              {updateProfile.error.message}
            </Text>
          ) : null}
          <Button
            label={updateProfile.isPending ? 'Saving…' : 'Save'}
            onPress={handleSave}
            disabled={updateProfile.isPending || name.trim().length === 0}
          />
        </View>
      </Screen>
    </Modal>
  );
}

/** Threads the current user blocked, with an unblock action per row —
 * only the person who blocked a thread can unblock it
 * (fn_set_thread_blocked enforces this server-side too, not just here). */
function BlockedContactsModal({
  visible,
  onClose,
  userId,
}: {
  visible: boolean;
  onClose: () => void;
  userId: string;
}) {
  const { spacing } = useTheme();
  const { data: blocked, isLoading } = useBlockedThreads(userId);
  const setBlocked = useSetThreadBlocked();

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Blocked contacts</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
          {isLoading ? (
            <Text variant="body" color="tertiary">
              Loading…
            </Text>
          ) : !blocked?.length ? (
            <Text variant="body" color="tertiary">
              No blocked contacts.
            </Text>
          ) : (
            blocked.map((b) => (
              <View
                key={b.thread_id}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingVertical: spacing.sm,
                }}
              >
                <Text variant="bodyMedium">{b.partner.display_name ?? 'Unnamed'}</Text>
                <Button
                  label="Unblock"
                  variant="secondary"
                  onPress={() => setBlocked.mutate({ threadId: b.thread_id, blocked: false })}
                />
              </View>
            ))
          )}
        </View>
      </Screen>
    </Modal>
  );
}

const REPORT_REASONS = [
  'Spam or scam',
  'Harassment or abuse',
  'Inappropriate content',
  'Something else',
];

/** Reports a user by phone number — a lighter-weight entry point than
 * requiring an active thread with them, since the app-store requirement
 * (docs/07-COMPLIANCE-LEGAL.md §4) is "a reporting system exists", not
 * specifically "reachable only mid-conversation". Reports aren't
 * readable back through the app (ops/admin review only). */
function ReportUserModal({
  visible,
  onClose,
  reporterId,
}: {
  visible: boolean;
  onClose: () => void;
  reporterId: string;
}) {
  const { colors, spacing, radius } = useTheme();
  const reportUser = useReportUser();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const [details, setDetails] = useState('');

  const reset = () => {
    setPhone('');
    setReason(null);
    setDetails('');
    reportUser.reset();
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!reason) return;
    const { data: found } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone.replace(/^\+/, ''))
      .maybeSingle();
    if (!found) {
      Alert.alert('Not found', 'No InvolveMe user has that phone number.');
      return;
    }
    reportUser.mutate(
      { reporterId, reportedUserId: found.id, reason, details: details.trim() || undefined },
      {
        onSuccess: () =>
          Alert.alert('Reported', 'Thanks — our team will review this.', [
            { text: 'OK', onPress: handleClose },
          ]),
      },
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <View
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <Text variant="title">Report a user</Text>
          <Pressable onPress={handleClose} hitSlop={12}>
            <Text variant="body" color="secondary">
              Close
            </Text>
          </Pressable>
        </View>

        <View style={{ gap: spacing.md, marginTop: spacing.xl }}>
          <Text variant="caption" color="tertiary">
            Their phone number
          </Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="0801 234 5678"
            placeholderTextColor={colors.textTertiary}
            keyboardType="phone-pad"
            style={{
              borderWidth: 1,
              borderColor: colors.borderSubtle,
              backgroundColor: colors.bgSurfaceAlt,
              color: colors.textPrimary,
              borderRadius: radius.card,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
            }}
          />

          <Text variant="caption" color="tertiary">
            Reason
          </Text>
          <View style={{ gap: spacing.xs }}>
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

          <TextInput
            value={details}
            onChangeText={setDetails}
            placeholder="Anything else we should know? (optional)"
            placeholderTextColor={colors.textTertiary}
            multiline
            style={{
              minHeight: 70,
              textAlignVertical: 'top',
              borderWidth: 1,
              borderColor: colors.borderSubtle,
              backgroundColor: colors.bgSurfaceAlt,
              color: colors.textPrimary,
              borderRadius: radius.card,
              paddingHorizontal: 16,
              paddingVertical: 14,
              fontSize: 16,
            }}
          />

          <Button
            label={reportUser.isPending ? 'Submitting…' : 'Submit report'}
            onPress={handleSubmit}
            disabled={reportUser.isPending || !reason || phone.length < 8}
          />
        </View>
      </Screen>
    </Modal>
  );
}

/** Sign-out + full account/profile/privacy/notifications settings. Bank-
 * account linking lives in the Wallet tab instead (a wallet action, not
 * account-level settings). */
export default function SettingsScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: profile } = useProfile(userId);
  const { data: pushEnabled, isLoading: pushLoading } = usePushEnabled(userId);
  const setPushEnabled = useSetPushEnabled();
  const setReadReceipts = useSetReadReceiptsEnabled();
  const setLastSeenEnabled = useSetLastSeenEnabled();
  const { data: deletionRequest } = useAccountDeletionRequest(userId);
  const requestDeletion = useRequestAccountDeletion();

  const [editProfileVisible, setEditProfileVisible] = useState(false);
  const [blockedListVisible, setBlockedListVisible] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);

  const handleSignOut = async () => {
    await unregisterPushToken();
    await supabase.auth.signOut();
    router.replace('/(auth)');
  };

  const handleTogglePush = async (enabled: boolean) => {
    if (!userId) return;
    const result = await setPushEnabled.mutateAsync({ userId, enabled });
    if (enabled && result === 'denied') {
      Alert.alert(
        'Notifications off',
        "Notification permission was denied. Turn it on in your phone's Settings app to receive them.",
      );
    } else if (enabled && result === 'unsupported') {
      Alert.alert('Not available', 'Push notifications need a real device, not a simulator.');
    } else if (enabled && result === 'error') {
      Alert.alert(
        "Couldn't turn on notifications",
        'Something went wrong reaching the notification service — check your connection and try again.',
      );
    }
  };

  const handleDeleteAccount = () => {
    if (!userId) return;
    Alert.alert(
      'Delete account',
      'This sends a request to our team for manual review — your wallet balance needs to be handled first, so this is not instant. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Request deletion',
          style: 'destructive',
          onPress: () => requestDeletion.mutate({ userId }),
        },
      ],
    );
  };

  const handleInviteFriend = () => {
    void shareInvite();
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Settings',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen>
        <View style={{ flex: 1 }}>
          <SectionHeader label="Profile" />
          <SettingsRow
            label={profile?.display_name ?? 'Add your name'}
            value={profile?.phone ? `+${profile.phone}` : undefined}
            onPress={() => setEditProfileVisible(true)}
          />
          {profile?.status_text ? (
            <SettingsRow label={profile.status_text} onPress={() => setEditProfileVisible(true)} />
          ) : null}

          <SectionHeader label="Appearance" />
          <AppearanceSection />

          <SectionHeader label="Account" />
          <KycSection />
          <SettingsRow
            label={
              deletionRequest?.status === 'pending'
                ? 'Deletion request pending'
                : 'Delete my account'
            }
            onPress={deletionRequest?.status === 'pending' ? undefined : handleDeleteAccount}
            destructive={deletionRequest?.status !== 'pending'}
          />

          <SectionHeader label="Privacy" />
          <SettingsRow
            label="Read receipts"
            right={
              <Switch
                value={profile?.read_receipts_enabled ?? true}
                onValueChange={(v) => {
                  if (userId) setReadReceipts.mutate({ userId, enabled: v });
                }}
              />
            }
          />
          <SettingsRow
            label="Last seen"
            right={
              <Switch
                value={profile?.last_seen_enabled ?? true}
                onValueChange={(v) => {
                  if (userId) setLastSeenEnabled.mutate({ userId, enabled: v });
                }}
              />
            }
          />
          <SettingsRow label="Blocked contacts" onPress={() => setBlockedListVisible(true)} />
          <SettingsRow label="Report a user" onPress={() => setReportVisible(true)} />

          <SectionHeader label="Notifications" />
          <SettingsRow
            label="Push notifications"
            right={
              <Switch
                value={!!pushEnabled}
                disabled={pushLoading || setPushEnabled.isPending}
                onValueChange={handleTogglePush}
              />
            }
          />

          <SectionHeader label="Help" />
          <SettingsRow label="Invite a friend" onPress={handleInviteFriend} />
          <SettingsRow label="Terms of Service" onPress={() => router.push('/legal/terms')} />
          <SettingsRow label="Privacy Policy" onPress={() => router.push('/legal/privacy')} />
          <SettingsRow label="App version" value={Constants.expoConfig?.version ?? '—'} />
        </View>

        <Button
          label="Sign out"
          variant="secondary"
          onPress={handleSignOut}
          style={{ marginTop: spacing.xl, marginBottom: spacing.xl }}
        />
      </Screen>

      {userId ? (
        <>
          <EditProfileModal
            visible={editProfileVisible}
            onClose={() => setEditProfileVisible(false)}
            userId={userId}
            currentName={profile?.display_name ?? null}
            currentStatus={profile?.status_text ?? null}
          />
          <BlockedContactsModal
            visible={blockedListVisible}
            onClose={() => setBlockedListVisible(false)}
            userId={userId}
          />
          <ReportUserModal
            visible={reportVisible}
            onClose={() => setReportVisible(false)}
            reporterId={userId}
          />
        </>
      ) : null}
    </>
  );
}
