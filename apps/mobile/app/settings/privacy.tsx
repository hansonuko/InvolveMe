import { Stack } from 'expo-router';
import { useState } from 'react';
import { Modal, Pressable, Switch, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import {
  useProfile,
  useReportUser,
  useSetLastSeenEnabled,
  useSetReadReceiptsEnabled,
} from '@/lib/queries/profile';
import { showAlert } from '@/lib/ui/alert';
import { useBlockedThreads, useSetThreadBlocked } from '@/lib/queries/threads';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme';

function SettingsRow({
  label,
  onPress,
  right,
}: {
  label: string;
  onPress?: () => void;
  right?: React.ReactNode;
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
      <Text variant="body">{label}</Text>
      {right ?? (onPress ? <Text color="tertiary">›</Text> : null)}
    </Pressable>
  );
}

/** Threads the current user blocked, with an unblock action per row —
 * only the person who blocked a thread can unblock it. Moved here
 * unchanged from the old flat settings/index.tsx (punch-list item 2's
 * Settings restructure). */
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

/** Reports a user by phone number — moved here unchanged from the old
 * flat settings/index.tsx. */
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
      showAlert('Not found', 'No InvolveMe user has that phone number.');
      return;
    }
    reportUser.mutate(
      { reporterId, reportedUserId: found.id, reason, details: details.trim() || undefined },
      {
        onSuccess: () =>
          showAlert('Reported', 'Thanks — our team will review this.', [
            { text: 'OK', onPress: handleClose },
          ]),
      },
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <KeyboardAvoidingScreen>
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
                fontSize: 17, // matches typography.body — punch-list item 4, 2026-09-19
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
                fontSize: 17, // matches typography.body — punch-list item 4, 2026-09-19
              }}
            />

            <Button
              label={reportUser.isPending ? 'Submitting…' : 'Submit report'}
              onPress={handleSubmit}
              disabled={reportUser.isPending || !reason || phone.length < 8}
            />
          </View>
        </KeyboardAvoidingScreen>
      </Screen>
    </Modal>
  );
}

export default function PrivacySettingsScreen() {
  const { colors } = useTheme();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: profile } = useProfile(userId);
  const setReadReceipts = useSetReadReceiptsEnabled();
  const setLastSeenEnabled = useSetLastSeenEnabled();

  const [blockedListVisible, setBlockedListVisible] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Privacy',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen edges={['right', 'bottom', 'left']}>
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
      </Screen>

      {userId ? (
        <>
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
