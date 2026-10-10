import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Modal, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { PrelaunchAnnouncementModal } from '@/components/PrelaunchAnnouncementModal';
import { WebDevicePairingScreen } from '@/components/WebDevicePairingScreen';
import {
  COUNTRY_DIAL_CODES,
  DEFAULT_COUNTRY_DIAL_CODE,
  type CountryDialCode,
} from '@/lib/countryDialCodes';
import { toE164Phone } from '@/lib/phone';
import { isPrelaunch, PRELAUNCH_SIGNUP_MESSAGE } from '@/lib/prelaunch';
import { supabase } from '@/lib/supabase';
import { showAlert } from '@/lib/ui/alert';
import { useAuthFlowStore } from '@/store/useAuthFlowStore';
import { isFullPwaHost } from '@/lib/webAppMode';
import { useTheme } from '@/theme';

/**
 * Root of the `(auth)` group — branches entirely by platform, and on web,
 * by hostname.
 *
 * On native, this is Phase 0 auth: phone number entry → Supabase OTP (see
 * docs/05-API-REALTIME-SPEC.md), unchanged below.
 *
 * On web, the *default* host (`web.involvemechat.com`, `involveme-
 * web.pages.dev`, localhost) is `involveme-web`'s QR-pairing companion
 * (docs/12-LINKED-DEVICES-WEB-SCOPING.md — the real WhatsApp Web model):
 * there is no phone entry at all, only an already-logged-in phone scanning
 * a QR code can authenticate this device. See `WebDevicePairingScreen`'s
 * own header comment.
 *
 * `app.involvemechat.com` (`lib/webAppMode.ts`) is the one exception —
 * docs/22-FULL-PWA-SCOPING.md's original standalone app, revived at its
 * own subdomain rather than conflated back into the pairing companion's
 * domain. Gets the exact same phone-entry/OTP flow native does. By the
 * time this screen can even render there, `app/_layout.tsx`'s own
 * `needsPwaInstall` gate has already confirmed this is a real installed
 * session, not a bare browser tab — nothing further to check here.
 */
export default function AuthEntryScreen() {
  const inner =
    Platform.OS === 'web' && !isFullPwaHost() ? <WebDevicePairingScreen /> : <PhoneEntryScreen />;

  // Web-only, covering both `app.involvemechat.com` and
  // `web.involvemechat.com` (native is never in prelaunch — the native app
  // isn't store-listed yet, so this gate would be meaningless there; see
  // PrelaunchAnnouncementModal's own header comment).
  if (Platform.OS !== 'web') return inner;
  return (
    <>
      {inner}
      <PrelaunchAnnouncementModal />
    </>
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
 *
 * Country-code picker (session 18, docs/10-UX-REFINEMENT-BACKLOG.md Batch
 * E's E2 spec item 1) — generalizes this screen off the Nigeria-only
 * default it shipped with, since this is the login funnel every existing
 * and new user goes through, not just first-time onboarding's own country
 * step (which is a separate, currency-focused pick — see
 * app/(auth)/onboarding.tsx's header comment for why the two aren't
 * unified). Defaults to +234 per CLAUDE.md's "NGN-only for now" posture.
 */
function PhoneEntryScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const setPendingPhone = useAuthFlowStore((s) => s.setPendingPhone);
  const termsAccepted = useAuthFlowStore((s) => s.termsAccepted);
  const setTermsAccepted = useAuthFlowStore((s) => s.setTermsAccepted);

  const [country, setCountry] = useState<CountryDialCode>(DEFAULT_COUNTRY_DIAL_CODE);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [phone, setPhone] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSendCode = async () => {
    setError(null);

    // Signup genuinely can't complete yet — SMS delivery isn't wired up
    // before launch (docs/00-SESSION-HANDOFF.md). Checked before the
    // network call, same reasoning as the marketing site's SignupForm, so
    // the visitor sees a clear "not yet" popup instead of a real send
    // attempt failing downstream with a confusing error.
    if (isPrelaunch()) {
      showAlert('Not open just yet', PRELAUNCH_SIGNUP_MESSAGE);
      return;
    }

    setIsSubmitting(true);
    const e164Phone = toE164Phone(phone, country.dialCode);
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
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Pressable
            onPress={() => setPickerVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Choose country code"
            style={[
              styles.dialCodeChip,
              {
                backgroundColor: colors.bgSurfaceAlt,
                borderRadius: radius.card,
                borderColor: colors.borderSubtle,
              },
            ]}
          >
            <Text variant="body">
              {country.code} {country.dialCode}
            </Text>
            <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
          </Pressable>

          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="800 000 0000"
            placeholderTextColor={colors.textSecondary}
            keyboardType="phone-pad"
            autoComplete="tel"
            style={[
              styles.input,
              {
                flex: 1,
                backgroundColor: colors.bgSurfaceAlt,
                color: colors.textPrimary,
                borderRadius: radius.card,
                borderColor: colors.borderSubtle,
              },
            ]}
          />
        </View>
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
          disabled={isSubmitting || phone.length < 6 || !termsAccepted}
        />
      </View>

      <Modal
        visible={pickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerVisible(false)}
      >
        <Pressable
          onPress={() => setPickerVisible(false)}
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'flex-end',
          }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: colors.bgSurface,
              borderTopLeftRadius: radius.card,
              borderTopRightRadius: radius.card,
              maxHeight: '70%',
              paddingTop: spacing.md,
            }}
          >
            <Text variant="caption" color="tertiary" style={{ textAlign: 'center' }}>
              Choose your country
            </Text>
            <FlatList
              data={COUNTRY_DIAL_CODES}
              keyExtractor={(item) => item.code}
              contentContainerStyle={{ paddingVertical: spacing.sm }}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => {
                    setCountry(item);
                    setPickerVisible(false);
                  }}
                  style={({ pressed }) => [
                    {
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      paddingVertical: spacing.md,
                      paddingHorizontal: spacing.lg,
                      backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
                    },
                  ]}
                >
                  <Text variant="body">{item.name}</Text>
                  <Text variant="body" color="secondary">
                    {item.dialCode}
                  </Text>
                </Pressable>
              )}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'center', gap: 48 },
  hero: { alignItems: 'flex-start' },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  dialCodeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  checkboxRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkboxLabel: { flex: 1 },
});
