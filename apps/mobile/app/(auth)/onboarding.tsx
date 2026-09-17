import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useOnboardingStatusStore } from '@/lib/onboardingStore';
import {
  type CountryCurrencyOption,
  useCompleteOnboarding,
  useCountryCurrencyOptions,
} from '@/lib/queries/onboarding';
import { useTheme } from '@/theme';

/**
 * First-signup onboarding (docs/10-UX-REFINEMENT-BACKLOG.md Batch E, E2):
 * country -> full name -> nickname -> currency auto-detect -> welcome.
 * Shown once, right after first-ever OTP verify — app/_layout.tsx's auth
 * gate routes here whenever useOnboardingStatusStore reports
 * needsOnboarding (users.display_name is null, the natural "first time"
 * signal E2's own spec names).
 *
 * This screen's own country step is separate from — and shipped after —
 * E2 spec item 1 (the phone-entry screen's own country-code picker,
 * session 18, `app/(auth)/index.tsx`): that one drives *which dial code*
 * the login OTP goes out on, this one drives *which currency* the
 * account's wallets use. They intentionally use different data sources
 * (a static dial-code list vs. the authenticated-only
 * `country_currency_config` table this screen reads) and aren't unified
 * into one picker, since a user's phone country and their wallet currency
 * aren't guaranteed to be the same choice.
 */
export default function OnboardingScreen() {
  const [step, setStep] = useState<'country' | 'profile' | 'welcome'>('country');
  const [country, setCountry] = useState<CountryCurrencyOption | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [resolvedCurrency, setResolvedCurrency] = useState<string | null>(null);
  const [paymentsLive, setPaymentsLive] = useState(true);

  const { data: countries, isLoading: countriesLoading } = useCountryCurrencyOptions();
  const completeOnboarding = useCompleteOnboarding();

  const handleSubmitProfile = async () => {
    if (!country) return;
    setError(null);
    try {
      const result = await completeOnboarding.mutateAsync({
        country: country.country_code,
        display_name: displayName.trim(),
        nickname: nickname.trim(),
      });
      setResolvedCurrency(result.currency);
      setPaymentsLive(result.payments_live);
      // Flip this before navigating away from onboarding, not after — the
      // auth gate's own effect (app/_layout.tsx) would otherwise still see
      // needsOnboarding=true for a beat and bounce straight back here.
      useOnboardingStatusStore.getState().setNeedsOnboarding(false);
      setStep('welcome');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  };

  if (step === 'country') {
    return (
      <CountryStep
        countries={countries ?? []}
        loading={countriesLoading}
        onSelect={(c) => {
          setCountry(c);
          setStep('profile');
        }}
      />
    );
  }

  if (step === 'profile') {
    return (
      <ProfileStep
        country={country}
        displayName={displayName}
        nickname={nickname}
        error={error}
        submitting={completeOnboarding.isPending}
        onChangeDisplayName={setDisplayName}
        onChangeNickname={setNickname}
        onBack={() => setStep('country')}
        onSubmit={handleSubmitProfile}
      />
    );
  }

  return <WelcomeStep currency={resolvedCurrency} paymentsLive={paymentsLive} />;
}

function CountryStep({
  countries,
  loading,
  onSelect,
}: {
  countries: CountryCurrencyOption[];
  loading: boolean;
  onSelect: (c: CountryCurrencyOption) => void;
}) {
  const { colors, spacing, radius } = useTheme();

  return (
    <Screen style={styles.container}>
      <View>
        <Text variant="title">Where are you joining from?</Text>
        <Text variant="body" color="secondary" style={{ marginTop: spacing.xs }}>
          This sets your currency for buying and earning credit.
        </Text>
      </View>

      {loading ? (
        <Text variant="body" color="secondary">
          Loading countries…
        </Text>
      ) : (
        <FlatList
          data={countries}
          keyExtractor={(item) => item.country_code}
          contentContainerStyle={{ gap: spacing.xs }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => onSelect(item)}
              style={({ pressed }) => [
                styles.countryRow,
                {
                  backgroundColor: pressed ? colors.bgSurfaceAlt : colors.bgSurface,
                  borderRadius: radius.card,
                  paddingVertical: spacing.md,
                  paddingHorizontal: spacing.lg,
                },
              ]}
            >
              <Text variant="body">{item.country_code}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Text variant="caption" color="secondary">
                  {item.currency}
                </Text>
                {!item.payments_live ? (
                  <Text variant="caption" color="tertiary">
                    (NGN only for now)
                  </Text>
                ) : null}
                <Ionicons name="chevron-forward" size={18} color={colors.textTertiary} />
              </View>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

function ProfileStep({
  country,
  displayName,
  nickname,
  error,
  submitting,
  onChangeDisplayName,
  onChangeNickname,
  onBack,
  onSubmit,
}: {
  country: CountryCurrencyOption | null;
  displayName: string;
  nickname: string;
  error: string | null;
  submitting: boolean;
  onChangeDisplayName: (v: string) => void;
  onChangeNickname: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}) {
  const { colors, spacing, radius } = useTheme();

  return (
    <Screen style={styles.container}>
      <View>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text variant="caption" color="brand">
            ← Change country
          </Text>
        </Pressable>
        <Text variant="title" style={{ marginTop: spacing.md }}>
          Tell us about you
        </Text>
        {country && !country.payments_live ? (
          <Text variant="caption" color="tertiary" style={{ marginTop: spacing.xs }}>
            Payments for {country.currency} aren&apos;t live yet — you&apos;ll use NGN for now.
          </Text>
        ) : null}
      </View>

      <View style={{ gap: spacing.md }}>
        <View>
          <Text variant="caption" color="secondary">
            Full name
          </Text>
          <TextInput
            value={displayName}
            onChangeText={onChangeDisplayName}
            placeholder="Jane Doe"
            placeholderTextColor={colors.textSecondary}
            style={[
              styles.input,
              {
                backgroundColor: colors.bgSurfaceAlt,
                color: colors.textPrimary,
                borderRadius: radius.card,
                borderColor: colors.borderSubtle,
                marginTop: spacing.xs,
              },
            ]}
          />
        </View>

        <View>
          <Text variant="caption" color="secondary">
            Nickname (shown to others)
          </Text>
          <TextInput
            value={nickname}
            onChangeText={onChangeNickname}
            placeholder="Janie"
            placeholderTextColor={colors.textSecondary}
            style={[
              styles.input,
              {
                backgroundColor: colors.bgSurfaceAlt,
                color: colors.textPrimary,
                borderRadius: radius.card,
                borderColor: colors.borderSubtle,
                marginTop: spacing.xs,
              },
            ]}
          />
        </View>

        {error ? (
          <Text variant="caption" color="danger">
            {error}
          </Text>
        ) : null}

        <Button
          label={submitting ? 'Setting up…' : 'Continue'}
          onPress={onSubmit}
          disabled={submitting || displayName.trim().length === 0 || nickname.trim().length === 0}
        />
      </View>
    </Screen>
  );
}

function WelcomeStep({
  currency,
  paymentsLive,
}: {
  currency: string | null;
  paymentsLive: boolean;
}) {
  const { spacing } = useTheme();
  const router = useRouter();

  return (
    <Screen style={[styles.container, styles.centered]}>
      <Animated.View entering={FadeIn.duration(500)} style={styles.centered}>
        <Text style={styles.emoji}>💬🎉</Text>
        <Text variant="display" style={{ marginTop: spacing.lg, textAlign: 'center' }}>
          You&apos;re all set!
        </Text>
        <Text
          variant="body"
          color="secondary"
          style={{ marginTop: spacing.sm, textAlign: 'center' }}
        >
          {paymentsLive
            ? `Your wallet is ready in ${currency}.`
            : `Your wallet is ready in NGN — ${currency} payments are coming soon.`}
        </Text>
      </Animated.View>

      <Button label="Start chatting" onPress={() => router.replace('/(tabs)/chats')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'space-between', gap: 24, flex: 1, paddingVertical: 24 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  countryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  emoji: { fontSize: 56 },
});
