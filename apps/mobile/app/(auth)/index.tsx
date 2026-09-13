import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { toE164NigerianPhone } from '@/lib/phone';
import { supabase } from '@/lib/supabase';
import { useAuthFlowStore } from '@/store/useAuthFlowStore';
import { useTheme } from '@/theme';

/** Phase 0 auth: phone number entry → Supabase OTP. See docs/05-API-REALTIME-SPEC.md. */
export default function PhoneEntryScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const setPendingPhone = useAuthFlowStore((s) => s.setPendingPhone);

  const [phone, setPhone] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSendCode = async () => {
    setError(null);
    setIsSubmitting(true);
    const e164Phone = toE164NigerianPhone(phone);
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: e164Phone });
    setIsSubmitting(false);

    if (otpError) {
      setError(otpError.message);
      return;
    }

    setPendingPhone(e164Phone);
    router.push('/(auth)/verify');
  };

  return (
    <Screen style={styles.container}>
      <View style={styles.hero}>
        <Text variant="display">InvolveMe</Text>
        <Text variant="body" color="secondary" style={{ marginTop: spacing.sm }}>
          Get paid for your time, one conversation at a time.
        </Text>
      </View>

      <View style={{ gap: spacing.md }}>
        <Text variant="caption" color="secondary">
          Phone number
        </Text>
        <TextInput
          value={phone}
          onChangeText={setPhone}
          placeholder="+234 800 000 0000"
          placeholderTextColor={colors.textSecondary}
          keyboardType="phone-pad"
          autoComplete="tel"
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
          label={isSubmitting ? 'Sending code…' : 'Send code'}
          onPress={handleSendCode}
          disabled={isSubmitting || phone.length < 8}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'center', gap: 48 },
  hero: { alignItems: 'flex-start' },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
});
