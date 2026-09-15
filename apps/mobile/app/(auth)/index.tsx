import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { toE164NigerianPhone } from '@/lib/phone';
import { supabase } from '@/lib/supabase';
import { useAuthFlowStore } from '@/store/useAuthFlowStore';
import { useTheme } from '@/theme';

/** Phase 0 auth: phone number entry → Supabase OTP. See docs/05-API-REALTIME-SPEC.md.
 *
 * Age gate + Terms/Privacy acceptance (session 13, continued —
 * docs/07-COMPLIANCE-LEGAL.md §4): one combined checkbox, the standard
 * pattern virtually every messaging app uses at signup, since neither
 * this app nor Prembly's real KYC response carries a date of birth to
 * check against (confirmed this session). The checkbox itself is the
 * actual app-store-facing gate — "Send code" is disabled without it; the
 * server-side terms_accepted_at write (app/(auth)/verify.tsx, once a real
 * user row exists) is the audit trail, not the enforcement point. */
export default function PhoneEntryScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const setPendingPhone = useAuthFlowStore((s) => s.setPendingPhone);
  const termsAccepted = useAuthFlowStore((s) => s.termsAccepted);
  const setTermsAccepted = useAuthFlowStore((s) => s.setTermsAccepted);

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

        <Pressable
          onPress={() => setTermsAccepted(!termsAccepted)}
          style={styles.checkboxRow}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: termsAccepted }}
        >
          <Ionicons
            name={termsAccepted ? 'checkbox' : 'square-outline'}
            size={22}
            color={termsAccepted ? colors.brandPrimary : colors.textSecondary}
          />
          <Text variant="caption" color="secondary" style={styles.checkboxLabel}>
            I confirm I&apos;m 18 or older and agree to the{' '}
            <Text variant="caption" color="brand" onPress={() => router.push('/legal/terms')}>
              Terms of Service
            </Text>{' '}
            and{' '}
            <Text variant="caption" color="brand" onPress={() => router.push('/legal/privacy')}>
              Privacy Policy
            </Text>
            .
          </Text>
        </Pressable>

        <Button
          label={isSubmitting ? 'Sending code…' : 'Send code'}
          onPress={handleSendCode}
          disabled={isSubmitting || phone.length < 8 || !termsAccepted}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'center', gap: 48 },
  hero: { alignItems: 'flex-start' },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkboxLabel: { flex: 1 },
});
