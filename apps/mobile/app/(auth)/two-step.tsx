import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { KeyboardAvoidingScreen } from '@/components/ui/KeyboardAvoidingScreen';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { useSession } from '@/lib/hooks/useSession';
import {
  useCompleteTwoStepReset,
  useRequestTwoStepReset,
  useVerifyTwoStepPin,
} from '@/lib/queries/twoStep';
import { supabase } from '@/lib/supabase';
import { useTwoStepGateStore } from '@/lib/twoStepGateStore';
import { useTheme } from '@/theme';

/** `now` is passed in rather than read via `Date.now()` internally — this
 * is called during render, and React Compiler's purity rule doesn't allow
 * an impure call there (see the `now` ticking-state comment further
 * down, same pattern thread/[id].tsx's own formatLastSeen already uses
 * for the identical reason). */
function formatWaitTime(availableAtIso: string, now: number): string {
  const ms = new Date(availableAtIso).getTime() - now;
  if (ms <= 0) return 'now';
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  return days === 1 ? '1 more day' : `${days} more days`;
}

/** The login-time two-step-verification gate (punch-list item 2) — reached
 * right after a fresh phone+OTP sign-in, before the auth gate
 * (app/_layout.tsx's useAuthGate) lets the session into `/(tabs)`. Only
 * shown when `useTwoStepGateStore`'s check finds `two_step_enabled` on
 * for this account; a device with it off never routes here at all.
 *
 * "Forgot PIN?" starts a cooldown rather than an instant bypass — see
 * request-two-step-reset's own header comment for why a fresh OTP alone
 * (which is exactly how the user got to this screen) can't safely clear
 * a PIN meant to add a second factor on top of OTP. */
export default function TwoStepScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const { session } = useSession();
  const markVerified = useTwoStepGateStore((s) => s.markVerified);

  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<string | null>(null);
  const [resetState, setResetState] = useState<{ availableAt: string } | null>(null);

  const verifyPin = useVerifyTwoStepPin();
  const requestReset = useRequestTwoStepReset();
  const completeReset = useCompleteTwoStepReset();

  const handleVerify = () => {
    setError(null);
    verifyPin.mutate(
      { pin },
      {
        onSuccess: (data) => {
          if (data.verified) {
            markVerified();
            return;
          }
          setPin('');
          if (data.locked_until) {
            setLockedUntil(data.locked_until);
          } else {
            setError('Incorrect PIN. Try again.');
          }
        },
        onError: (e) => setError(e.message),
      },
    );
  };

  const handleForgotPin = () => {
    setError(null);
    requestReset.mutate(undefined, {
      onSuccess: (data) => setResetState({ availableAt: data.available_at }),
      onError: (e) => setError(e.message),
    });
  };

  const handleCompleteReset = () => {
    setError(null);
    completeReset.mutate(undefined, {
      onSuccess: () => markVerified(),
      onError: (e) => setError(e.message),
    });
  };

  const handleSignOutInstead = async () => {
    await supabase.auth.signOut();
    router.replace('/(auth)');
  };

  // Date.now() is an impure call, not allowed directly in render (React
  // Compiler's purity rule) — same ticking-`now`-state shape
  // thread/[id].tsx already established for its own "keeps re-evaluating
  // from time passing alone" need: the lazy useState initializer runs
  // once (allowed), and the interval's setState call happens
  // asynchronously inside the timer callback, not synchronously in the
  // effect body (the thing react-hooks/set-state-in-effect actually
  // objects to). `cooldownElapsed` itself is then a plain, pure
  // computation from `now` during render.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);
  const cooldownElapsed = resetState ? new Date(resetState.availableAt).getTime() <= now : false;

  return (
    <Screen>
      <KeyboardAvoidingScreen style={styles.container}>
        <View>
          <Text variant="title">Two-step verification</Text>
          <Text variant="body" color="secondary" style={{ marginTop: spacing.xs }}>
            Enter your 6-digit PIN to continue.
          </Text>
        </View>

        {resetState ? (
          <View style={{ gap: spacing.md }}>
            <Text variant="body" color="secondary">
              {cooldownElapsed
                ? 'The waiting period is over — you can continue without your PIN. Set a new one in Settings once you’re in.'
                : `Forgot your PIN? For your security, we can only turn off two-step verification after a short waiting period — ${formatWaitTime(resetState.availableAt, now)} left.`}
            </Text>
            {cooldownElapsed ? (
              <Button
                label={completeReset.isPending ? 'Continuing…' : 'Continue without PIN'}
                onPress={handleCompleteReset}
                disabled={completeReset.isPending}
              />
            ) : null}
            <Text
              variant="caption"
              color="secondary"
              onPress={() => setResetState(null)}
              style={{ textAlign: 'center' }}
            >
              I remember my PIN
            </Text>
          </View>
        ) : (
          <View style={{ gap: spacing.md }}>
            <TextInput
              value={pin}
              onChangeText={(v) => setPin(v.replace(/[^0-9]/g, '').slice(0, 6))}
              placeholder="••••••"
              placeholderTextColor={colors.textSecondary}
              keyboardType="number-pad"
              maxLength={6}
              secureTextEntry
              editable={!lockedUntil}
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
            {lockedUntil ? (
              <Text variant="caption" color="danger" style={{ textAlign: 'center' }}>
                Too many incorrect attempts. Try again after{' '}
                {new Date(lockedUntil).toLocaleTimeString(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
                .
              </Text>
            ) : error ? (
              <Text variant="caption" color="danger" style={{ textAlign: 'center' }}>
                {error}
              </Text>
            ) : null}
            <Button
              label={verifyPin.isPending ? 'Verifying…' : 'Verify'}
              onPress={handleVerify}
              disabled={verifyPin.isPending || pin.length !== 6 || !!lockedUntil}
            />
            <Text
              variant="caption"
              color="secondary"
              onPress={handleForgotPin}
              style={{ textAlign: 'center' }}
            >
              {requestReset.isPending ? 'Please wait…' : 'Forgot PIN?'}
            </Text>
          </View>
        )}

        <Text
          variant="caption"
          color="tertiary"
          onPress={handleSignOutInstead}
          style={{ textAlign: 'center' }}
        >
          Not {session?.user.phone ? `+${session.user.phone}` : 'you'}? Sign out
        </Text>
      </KeyboardAvoidingScreen>
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
