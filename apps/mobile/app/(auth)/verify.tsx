import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { supabase } from '@/lib/supabase';
import { useAuthFlowStore } from '@/store/useAuthFlowStore';
import { useTheme } from '@/theme';

/** OTP verification. On success, Supabase's session listener flips the auth
 * gate in app/_layout.tsx and routes into (tabs) automatically. */
export default function VerifyOtpScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const pendingPhone = useAuthFlowStore((s) => s.pendingPhone);
  const termsAccepted = useAuthFlowStore((s) => s.termsAccepted);

  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleVerify = async () => {
    if (!pendingPhone) {
      router.replace('/(auth)');
      return;
    }

    setError(null);
    setIsSubmitting(true);
    const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
      phone: pendingPhone,
      token: code,
      type: 'sms',
    });
    setIsSubmitting(false);

    if (verifyError) {
      setError(verifyError.message);
      return;
    }

    // Record the age-gate/Terms-Privacy consent now that a real user row
    // exists — best-effort: the checkbox on the previous screen is the
    // actual app-store-facing gate (an OTP was never even sent without
    // it), this is the server-side audit trail. A rare write failure here
    // shouldn't lock a legitimate, just-verified user out of the app.
    if (termsAccepted && verifyData.user) {
      const { error: termsError } = await supabase
        .from('users')
        .update({ terms_accepted_at: new Date().toISOString() })
        .eq('id', verifyData.user.id);
      if (termsError) {
        console.error('Failed to record terms_accepted_at:', termsError.message);
      }
    }
    // Success case: no navigation call needed — the session change fires the
    // auth-gate redirect in app/_layout.tsx.
  };

  return (
    <Screen style={styles.container}>
      <View>
        <Text variant="title">Enter the code</Text>
        <Text variant="body" color="secondary" style={{ marginTop: spacing.xs }}>
          Sent to {pendingPhone ?? 'your phone'}
        </Text>
      </View>

      <View style={{ gap: spacing.md }}>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="123456"
          placeholderTextColor={colors.textSecondary}
          keyboardType="number-pad"
          maxLength={6}
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
        {error ? (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        ) : null}
        <Button
          label={isSubmitting ? 'Verifying…' : 'Verify'}
          onPress={handleVerify}
          disabled={isSubmitting || code.length < 4}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'center', gap: 48 },
  input: {
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
  },
});
