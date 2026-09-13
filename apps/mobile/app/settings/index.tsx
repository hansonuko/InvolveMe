import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import { useKycTier, useSubmitKyc } from '@/lib/queries/kyc';
import { supabase } from '@/lib/supabase';
import { useTheme } from '@/theme';

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
      <View style={{ marginTop: spacing.xl }}>
        <Text variant="title">Identity</Text>
        <Text variant="bodyMedium" color="success" style={{ marginTop: spacing.sm }}>
          Verified ✓
        </Text>
      </View>
    );
  }

  return (
    <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
      <Text variant="title">Verify your identity</Text>
      <Text variant="caption" color="secondary">
        Required before you can withdraw. Uses your BVN or NIN — no camera, no photos.
      </Text>

      {submitKyc.isSuccess ? (
        <Text variant="bodyMedium" color="success">
          Verified ✓
        </Text>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
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
            placeholderTextColor={colors.textSecondary}
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

/** Sign-out + identity verification. Bank-account linking lives in the
 * Wallet tab instead (see (tabs)/wallet.tsx) — it's a wallet action, this
 * screen is account-level settings. */
export default function SettingsScreen() {
  const { spacing } = useTheme();
  const router = useRouter();

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace('/(auth)');
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: true, title: 'Settings' }} />
      <Screen style={{ justifyContent: 'space-between' }}>
        <View>
          <KycSection />
        </View>
        <Button
          label="Sign out"
          variant="secondary"
          onPress={handleSignOut}
          style={{ marginTop: spacing.xl }}
        />
      </Screen>
    </>
  );
}
