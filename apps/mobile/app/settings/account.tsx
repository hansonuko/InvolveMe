import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, ScrollView, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { useKycTier, useSubmitKyc } from '@/lib/queries/kyc';
import {
  useAccountDeletionRequest,
  useProfile,
  useRequestAccountDeletion,
} from '@/lib/queries/profile';
import { useDisableTwoStep, useSetTwoStepPin } from '@/lib/queries/twoStep';
import { useTheme } from '@/theme';

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

function pinInputStyle(
  colors: ReturnType<typeof useTheme>['colors'],
  radius: ReturnType<typeof useTheme>['radius'],
) {
  return {
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgSurfaceAlt,
    color: colors.textPrimary,
    borderRadius: radius.card,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center' as const,
  };
}

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

  if (isLoading) return null;

  if ((kycTier ?? 0) >= 1) {
    return (
      <Text variant="bodyMedium" color="success">
        Verified ✓
      </Text>
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Two-step verification management — punch-list item 2's "similar to
 * WhatsApp" account-security ask, built as a real PIN (WhatsApp itself
 * has no password login either) rather than a password field. See
 * 20260918110000_profile_media_and_two_step.sql's header comment for the
 * full reasoning, including why "forgot PIN" is a cooldown, not an
 * instant OTP-based bypass — that logic lives in the login-time gate
 * (app/(auth)/two-step.tsx), not here; this screen is only reached by
 * someone who already has full app access. */
function TwoStepSection({ enabled }: { enabled: boolean }) {
  const { colors, spacing, radius } = useTheme();
  const setPin = useSetTwoStepPin();
  const disable = useDisableTwoStep();

  const [mode, setMode] = useState<'idle' | 'setup' | 'change' | 'disable'>('idle');
  const [pin, setPinValue] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const reset = () => {
    setMode('idle');
    setPinValue('');
    setConfirmPin('');
    setCurrentPin('');
    setRecoveryEmail('');
    setError(null);
    setPin.reset();
    disable.reset();
  };

  const handleSubmitSetupOrChange = () => {
    setError(null);
    if (pin.length !== 6) {
      setError('PIN must be exactly 6 digits.');
      return;
    }
    if (pin !== confirmPin) {
      setError('PINs do not match.');
      return;
    }
    if (recoveryEmail && !EMAIL_RE.test(recoveryEmail)) {
      setError('That doesn’t look like a valid email address.');
      return;
    }
    setPin.mutate(
      {
        pin,
        currentPin: mode === 'change' ? currentPin : undefined,
        recoveryEmail: recoveryEmail || undefined,
      },
      {
        onSuccess: () => {
          setSuccess(mode === 'change' ? 'PIN changed.' : 'Two-step verification is on.');
          reset();
        },
        onError: (e) => setError(e.message),
      },
    );
  };

  const handleDisable = () => {
    setError(null);
    if (currentPin.length !== 6) {
      setError('Enter your current 6-digit PIN.');
      return;
    }
    disable.mutate(
      { currentPin },
      {
        onSuccess: () => {
          setSuccess('Two-step verification is off.');
          reset();
        },
        onError: (e) => setError(e.message),
      },
    );
  };

  if (mode === 'idle') {
    return (
      <View style={{ gap: spacing.sm }}>
        <Text variant="body">
          Two-step verification is{' '}
          <Text color={enabled ? 'success' : 'tertiary'}>{enabled ? 'on' : 'off'}</Text>
        </Text>
        <Text variant="caption" color="tertiary">
          Adds a 6-digit PIN on top of your phone number, so nobody else can register it on a new
          device even if they receive your SMS code.
        </Text>
        {success ? (
          <Text variant="caption" color="success">
            {success}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {enabled ? (
            <>
              <Button label="Change PIN" variant="secondary" onPress={() => setMode('change')} />
              <Button label="Turn off" variant="secondary" onPress={() => setMode('disable')} />
            </>
          ) : (
            <Button label="Turn on" onPress={() => setMode('setup')} />
          )}
        </View>
      </View>
    );
  }

  if (mode === 'disable') {
    return (
      <View style={{ gap: spacing.sm }}>
        <Text variant="caption" color="tertiary">
          Enter your current PIN to turn two-step verification off.
        </Text>
        <TextInput
          value={currentPin}
          onChangeText={(v) => setCurrentPin(v.replace(/[^0-9]/g, '').slice(0, 6))}
          placeholder="••••••"
          placeholderTextColor={colors.textTertiary}
          keyboardType="number-pad"
          maxLength={6}
          secureTextEntry
          style={pinInputStyle(colors, radius)}
        />
        {error ? (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button
            label={disable.isPending ? 'Turning off…' : 'Turn off'}
            onPress={handleDisable}
            disabled={disable.isPending}
          />
          <Button label="Cancel" variant="secondary" onPress={reset} />
        </View>
      </View>
    );
  }

  // setup or change
  return (
    <View style={{ gap: spacing.sm }}>
      {mode === 'change' ? (
        <>
          <Text variant="caption" color="tertiary">
            Current PIN
          </Text>
          <TextInput
            value={currentPin}
            onChangeText={(v) => setCurrentPin(v.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="••••••"
            placeholderTextColor={colors.textTertiary}
            keyboardType="number-pad"
            maxLength={6}
            secureTextEntry
            style={pinInputStyle(colors, radius)}
          />
        </>
      ) : null}
      <Text variant="caption" color="tertiary">
        New 6-digit PIN
      </Text>
      <TextInput
        value={pin}
        onChangeText={(v) => setPinValue(v.replace(/[^0-9]/g, '').slice(0, 6))}
        placeholder="••••••"
        placeholderTextColor={colors.textTertiary}
        keyboardType="number-pad"
        maxLength={6}
        secureTextEntry
        style={pinInputStyle(colors, radius)}
      />
      <Text variant="caption" color="tertiary">
        Confirm PIN
      </Text>
      <TextInput
        value={confirmPin}
        onChangeText={(v) => setConfirmPin(v.replace(/[^0-9]/g, '').slice(0, 6))}
        placeholder="••••••"
        placeholderTextColor={colors.textTertiary}
        keyboardType="number-pad"
        maxLength={6}
        secureTextEntry
        style={pinInputStyle(colors, radius)}
      />
      {mode === 'setup' ? (
        <>
          <Text variant="caption" color="tertiary">
            Recovery email (optional)
          </Text>
          <TextInput
            value={recoveryEmail}
            onChangeText={setRecoveryEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textTertiary}
            autoCapitalize="none"
            keyboardType="email-address"
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
            Not used to send anything yet — this app doesn’t send email. It’s captured so a future
            email-based PIN reset has somewhere to send to.
          </Text>
        </>
      ) : null}
      {error ? (
        <Text variant="caption" color="danger">
          {error}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          label={setPin.isPending ? 'Saving…' : mode === 'change' ? 'Change PIN' : 'Turn on'}
          onPress={handleSubmitSetupOrChange}
          disabled={setPin.isPending}
        />
        <Button label="Cancel" variant="secondary" onPress={reset} />
      </View>
    </View>
  );
}

export default function AccountSettingsScreen() {
  const { colors, spacing } = useTheme();
  const { session } = useSession();
  const userId = session?.user.id;

  const { data: profile } = useProfile(userId);
  const { data: deletionRequest } = useAccountDeletionRequest(userId);
  const requestDeletion = useRequestAccountDeletion();

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

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Account',
          headerStyle: { backgroundColor: colors.bgCanvas },
          headerTintColor: colors.textSecondary,
          headerTitleStyle: { color: colors.textPrimary },
        }}
      />
      <Screen>
        <KeyboardAvoidingScreen>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: spacing.xl }}
          >
            <Text variant="body" color="tertiary">
              {profile?.phone ? `+${profile.phone}` : ''}
            </Text>

            <SectionHeader label="Identity verification" />
            <KycSection />

            <SectionHeader label="Two-step verification" />
            <TwoStepSection enabled={profile?.two_step_enabled ?? false} />

            <SectionHeader label="Danger zone" />
            <Text
              variant="body"
              color={deletionRequest?.status === 'pending' ? 'tertiary' : 'danger'}
              onPress={deletionRequest?.status === 'pending' ? undefined : handleDeleteAccount}
            >
              {deletionRequest?.status === 'pending'
                ? 'Deletion request pending'
                : 'Delete my account'}
            </Text>
          </ScrollView>
        </KeyboardAvoidingScreen>
      </Screen>
    </>
  );
}
