import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { WebDevicePairingScreen } from '@/components/WebDevicePairingScreen';
import { supabase } from '@/lib/supabase';
import { useAuthFlowStore } from '@/store/useAuthFlowStore';
import { isFullPwaHost } from '@/lib/webAppMode';
import { useTheme } from '@/theme';

/**
 * Root of the `(auth)` group — branches entirely by platform, and on web,
 * by hostname.
 *
 * On native, this is Phase 0 auth: email entry → Supabase OTP (see
 * docs/05-API-REALTIME-SPEC.md). Switched from phone to email 2026-11-08
 * — phone-number signup is deferred to a future pass (SMS delivery isn't
 * reliably wired up yet); email is what's actually available today. The
 * phone helpers this screen used to import (`@/lib/phone`,
 * `@/lib/countryDialCodes`) are left in place, unused by this screen for
 * now, for whenever that future pass actually adds phone back.
 *
 * On web, the *default* host (`web.involvemechat.com`, `involveme-
 * web.pages.dev`, localhost) is `involveme-web`'s QR-pairing companion
 * (docs/12-LINKED-DEVICES-WEB-SCOPING.md — the real WhatsApp Web model):
 * there is no email entry at all, only an already-logged-in phone scanning
 * a QR code can authenticate this device. See `WebDevicePairingScreen`'s
 * own header comment.
 *
 * `app.involvemechat.com` (`lib/webAppMode.ts`) is the one exception —
 * docs/22-FULL-PWA-SCOPING.md's original standalone app, revived at its
 * own subdomain rather than conflated back into the pairing companion's
 * domain. Gets the exact same email-entry/OTP flow native does. By the
 * time this screen can even render there, `app/_layout.tsx`'s own
 * `needsPwaInstall` gate has already confirmed this is a real installed
 * session, not a bare browser tab — nothing further to check here.
 */
export default function AuthEntryScreen() {
  return Platform.OS === 'web' && !isFullPwaHost() ? (
    <WebDevicePairingScreen />
  ) : (
    <EmailEntryScreen />
  );
}

/**
 * Age gate + Terms/Privacy acceptance (session 13, continued —
 * docs/07-COMPLIANCE-LEGAL.md §4): one combined checkbox, the standard
 * pattern virtually every messaging app uses at signup, since neither
 * this app nor Prembly's real KYC response carries a date of birth to
 * check against (confirmed this session). The checkbox itself is the
 * actual app-store-facing gate — "Send code" is disabled without it; the
 * server-side terms_accepted_at write (app/(auth)/verify.tsx, once a real
 * user row exists) is the audit trail, not the enforcement point.
 */
function EmailEntryScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const setPendingEmail = useAuthFlowStore((s) => s.setPendingEmail);
  const termsAccepted = useAuthFlowStore((s) => s.termsAccepted);
  const setTermsAccepted = useAuthFlowStore((s) => s.setTermsAccepted);

  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSendCode = async () => {
    setError(null);
    setIsSubmitting(true);
    const { error: otpError } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setIsSubmitting(false);

    if (otpError) {
      setError(otpError.message);
      return;
    }

    setPendingEmail(email.trim());
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
          Email address
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={colors.textSecondary}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
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
          disabled={isSubmitting || !email.includes('@') || !termsAccepted}
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
