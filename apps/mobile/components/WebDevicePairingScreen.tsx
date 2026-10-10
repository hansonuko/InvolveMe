import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import QRCode from 'react-native-qrcode-svg';

import { ActionSheet } from '@/components/ui/ActionSheet';
import { AppHeader } from '@/components/ui/AppHeader';
import { Ring } from '@/components/ui/Ring';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { WebFooter } from '@/components/WebFooter';
import { EdgeFunctionError } from '@/lib/edgeFunctions';
import { useIsWideWeb } from '@/lib/hooks/useIsWideWeb';
import { usePwaInstallPrompt } from '@/lib/hooks/usePwaInstallPrompt';
import {
  buildDevicePairingDeepLink,
  createDevicePairing,
  describeWebDevice,
  getDevicePairingStatus,
} from '@/lib/linkedDevicePairing';
import { MARKETING_URL } from '@/lib/marketingUrl';
import { supabase } from '@/lib/supabase';
import { showAlert } from '@/lib/ui/alert';
import { useTheme } from '@/theme';

// Matches get-device-pairing-status's own polling guidance
// (docs/12-LINKED-DEVICES-WEB-SCOPING.md M2's header comment) — frequent
// enough to feel instant once the phone confirms, comfortably inside that
// function's own per-IP rate limit (60 calls / 2min) for a single pairing's
// ~60s expiry window.
const POLL_INTERVAL_MS = 2000;

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'pairing'; pairingId: string; expiresAt: number; totalSeconds: number }
  | { kind: 'linked' }
  | { kind: 'error'; message: string };

/**
 * docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 4 — `involveme-web`'s
 * actual root screen (`Platform.OS === 'web'`-gated from `app/(auth)/
 * index.tsx`). Replaces the OTP phone-entry flow entirely on web, per the
 * explicit product correction this feature is built on: a brand-new user
 * has no path in here, only an already-logged-in phone scanning this QR
 * code can authenticate this device — the real WhatsApp Web model.
 *
 * Deliberately has no success UI of its own: once `supabase.auth.
 * setSession()` resolves below, `app/_layout.tsx`'s existing `useAuthGate`
 * effect sees a real session and redirects away from here on its own —
 * this screen's only job is getting that one call made.
 */
export function WebDevicePairingScreen() {
  const { colors, spacing, radius } = useTheme();
  const { canInstall, promptInstall, isIosSafari } = usePwaInstallPrompt();
  const [downloadSheetVisible, setDownloadSheetVisible] = useState(false);
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against a stale poll's response landing after this component has
  // already moved on to a new pairing (or unmounted) — same "ignore a
  // response that arrived after we stopped caring" shape useSession's own
  // mount-guard uses elsewhere in this app.
  const pairingIdRef = useRef<string | null>(null);

  // "lively" per the explicit ask — a quiet entrance for the hero copy and
  // the QR card rather than everything just appearing instantly, plus a
  // slow ambient float on the two background blobs. Respects
  // useReducedMotion the same way AnimatedSplash.tsx already does (the one
  // other place in this app driving a mount animation off shared values) —
  // final state is identical either way, only the transition is skipped.
  const reducedMotion = useReducedMotion();
  const heroOpacity = useSharedValue(reducedMotion ? 1 : 0);
  const heroTranslateY = useSharedValue(reducedMotion ? 0 : 16);
  const cardOpacity = useSharedValue(reducedMotion ? 1 : 0);
  const cardScale = useSharedValue(reducedMotion ? 1 : 0.94);
  const blobFloat = useSharedValue(0);

  useEffect(() => {
    if (!reducedMotion) {
      heroOpacity.value = withTiming(1, { duration: 500, easing: Easing.out(Easing.cubic) });
      heroTranslateY.value = withTiming(0, { duration: 500, easing: Easing.out(Easing.cubic) });
      cardOpacity.value = withDelay(150, withTiming(1, { duration: 450 }));
      cardScale.value = withDelay(
        150,
        withTiming(1, { duration: 450, easing: Easing.out(Easing.back(1.2)) }),
      );
      blobFloat.value = withRepeat(
        withTiming(1, { duration: 6000, easing: Easing.inOut(Easing.sin) }),
        -1,
        true,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const heroStyle = useAnimatedStyle(() => ({
    opacity: heroOpacity.value,
    transform: [{ translateY: heroTranslateY.value }],
  }));
  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value,
    transform: [{ scale: cardScale.value }],
  }));
  const blobOneStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: blobFloat.value * -24 }, { translateX: blobFloat.value * 16 }],
  }));
  const blobTwoStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: blobFloat.value * 20 }, { translateX: blobFloat.value * -14 }],
  }));

  const isWide = useIsWideWeb();

  const clearTimers = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    if (tickRef.current) clearInterval(tickRef.current);
    pollRef.current = null;
    tickRef.current = null;
  }, []);

  const startPairing = useCallback(async () => {
    clearTimers();
    setState({ kind: 'loading' });
    try {
      const pairing = await createDevicePairing(describeWebDevice(), 'web');
      const expiresAt = new Date(pairing.expires_at).getTime();
      const totalSeconds = Math.max(1, Math.round((expiresAt - Date.now()) / 1000));
      pairingIdRef.current = pairing.pairing_id;
      setState({ kind: 'pairing', pairingId: pairing.pairing_id, expiresAt, totalSeconds });
    } catch (e) {
      const message =
        e instanceof EdgeFunctionError
          ? e.message
          : 'Could not start pairing — check your connection and try again.';
      setState({ kind: 'error', message });
    }
  }, [clearTimers]);

  // Wrapped in its own async IIFE rather than called directly — same
  // `react-hooks/set-state-in-effect` distinction lib/appLock.ts's
  // useAppLock effect already documents: a nested closure around the
  // async call is recognized as the legitimate "callback" case, a bare
  // `void startPairing()` is not.
  useEffect(() => {
    (async () => {
      await startPairing();
    })();
    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.kind !== 'pairing') return;
    const { pairingId, expiresAt } = state;

    tickRef.current = setInterval(() => {
      setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    }, 1000);
    // Deferred one microtask out, not called directly in the effect body —
    // same `react-hooks/set-state-in-effect` workaround app/thread/[id].tsx's
    // own optimistic-send effect already uses — so the countdown shows the
    // correct number immediately rather than waiting a full second for the
    // interval's first tick.
    queueMicrotask(() => {
      setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    });

    // Sequential poll-then-schedule-next, not `setInterval` — a real,
    // live-reproduced bug with `setInterval` here: `get-device-pairing-
    // status` marks a pairing's tokens consumed on first delivery
    // (single-use, M2's own header comment), so if a network round trip
    // ever takes longer than POLL_INTERVAL_MS, a second tick fires before
    // the first (which got 'confirmed' and is mid-`setSession()`) has
    // cleared this interval — that overlapping call lands on the now-
    // consumed row, sees 'already_delivered', and used to treat that the
    // same as 'expired' and spin up a brand new pairing, stomping the
    // session the first call had just established. `cancelled` below
    // closes that race: once this run commits to 'confirmed' or
    // 'expired', no further tick from this closure can fire at all.
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      try {
        const result = await getDevicePairingStatus(pairingId);
        if (cancelled || pairingIdRef.current !== pairingId) return; // superseded — ignore

        if (result.status === 'confirmed') {
          cancelled = true;
          clearTimers();
          const { error } = await supabase.auth.setSession({
            access_token: result.access_token,
            refresh_token: result.refresh_token,
          });
          if (error) {
            setState({
              kind: 'error',
              message: 'Linked, but could not start the session. Try again.',
            });
            return;
          }
          // 'linked' is a terminal state — nothing further to render here,
          // useAuthGate takes over the moment it sees the new session. This
          // exists mainly as defense in depth so `state.kind` can never
          // still read 'pairing' after a real link succeeds, closing off
          // the secondsLeft-driven auto-refresh effect below for good
          // (belt-and-suspenders alongside the `cancelled` guard this
          // closure already enforces against a racing duplicate poll).
          setState({ kind: 'linked' });
          return;
        }

        if (result.status === 'expired' || result.status === 'already_delivered') {
          // WhatsApp Web's own behavior: a dead QR silently refreshes
          // itself rather than leaving the user staring at a code that no
          // longer works. 'already_delivered' only reaches here for a
          // pairing this same poll loop didn't itself just consume (see
          // the `cancelled` guard above) — e.g. the code was scanned and
          // claimed by a stale duplicate request — so refreshing is the
          // right response for it too, not just 'expired'.
          cancelled = true;
          await startPairing();
          return;
        }
      } catch {
        // A transient poll failure (network blip, rate limit) isn't worth
        // surfacing — the next tick tries again. The pairing's own ~60s
        // expiry is what eventually forces a fresh code if this persists.
      }
      if (!cancelled) {
        pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    }
    pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      if (tickRef.current) clearInterval(tickRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind === 'pairing' ? state.pairingId : null]);

  // Deliberately NOT also refreshing locally whenever the `secondsLeft`
  // countdown display hits 0: a real, live-reproduced bug here —
  // `secondsLeft` is initialized to 0 (`useState(0)`) and only gets its
  // real value a microtask after a new pairing is created (see the poll
  // effect above), so a `secondsLeft === 0` check in its own effect fires
  // on the very first render of every new pairing too, immediately
  // discarding the QR that was just generated and creating another one —
  // confirmed via instrumented console logs showing a second pairing
  // created within 1s of the first, every single mount. The server-side
  // expiry (fn_create_device_pairing, device_pairing_expiry_seconds) is
  // the real enforcement regardless; the poll effect's own `'expired'`
  // branch above already refreshes off that authoritative signal, within
  // one `POLL_INTERVAL_MS` of it actually happening — no separate local-
  // clock trigger is needed, and this file no longer has one.

  // "Download the web app" here means installing *this* QR-pairing page
  // itself as a home-screen/desktop shortcut — a real, standalone use even
  // though it can't log a brand-new user in on its own (M4's own
  // architecture note): re-opening it to scan a fresh code, or because a
  // session expired, is a genuine standalone reason to want an icon for
  // it. `usePwaInstallPrompt` is the same hook `InstallPwaPrompt`'s own
  // floating banner already uses — one real `beforeinstallprompt`
  // subscription, not a second copy of it.
  const handleInstallWebApp = async () => {
    if (canInstall) {
      await promptInstall();
      return;
    }
    if (isIosSafari) {
      showAlert(
        'Add to Home Screen',
        'Tap the Share icon in Safari’s toolbar, then "Add to Home Screen".',
      );
      return;
    }
    // Desktop/Android Chrome before the browser's own install-eligibility
    // criteria have fired yet (e.g. just landed on the page this instant)
    // — same honest fallback the marketing site's Download page uses
    // rather than claiming a prompt that isn't actually available yet.
    showAlert(
      'Install not available yet',
      'Look for an install icon in your browser’s address bar, or check back in a moment.',
    );
  };

  const handleOpenAndroidDownload = () => {
    void Linking.openURL(`${MARKETING_URL}/download`);
  };

  const heroBlock = (
    <Animated.View style={[styles.hero, heroStyle, isWide ? styles.heroWide : null]}>
      <Text
        variant="hero"
        color="secondary"
        style={[styles.heroTitle, !isWide ? styles.heroTitleNarrow : null]}
      >
        Get paid, every time you reply.
      </Text>
      <Text
        variant="body"
        color="secondary"
        style={[styles.heroSubtitle, isWide ? null : { textAlign: 'center' }]}
      >
        No subscriptions, no ads — just real conversations that pay you back. Link this browser to
        keep chatting (and earning) from your desktop too.
      </Text>

      <View style={[styles.steps, { gap: spacing.sm }]}>
        <Text variant="bodyMedium">To link a device:</Text>
        <Text variant="body" color="secondary">
          1. Open InvolveMe on your phone
        </Text>
        <Text variant="body" color="secondary">
          2. Tap the menu, then Link a Device
        </Text>
        <Text variant="body" color="secondary">
          3. Point your phone at this screen to scan the code
        </Text>
      </View>
    </Animated.View>
  );

  const qrCard = (
    <Animated.View
      style={[
        styles.card,
        cardStyle,
        {
          backgroundColor: colors.bgSurface,
          borderColor: colors.borderSubtle,
          borderRadius: radius.card,
          padding: spacing.xl,
          gap: spacing.lg,
        },
      ]}
    >
      <View style={styles.qrWrap}>
        {state.kind === 'pairing' ? (
          <>
            <QRCode value={buildDevicePairingDeepLink(state.pairingId)} size={220} />
            <View style={[styles.countdown, { gap: spacing.xs }]}>
              <Ring
                size={28}
                strokeWidth={3}
                progress={secondsLeft / state.totalSeconds}
                colors={[colors.brandPrimary]}
                trackColor={colors.borderSubtle}
              />
              <Text variant="caption" color="tertiary">
                Refreshes in {secondsLeft}s
              </Text>
            </View>
          </>
        ) : state.kind === 'error' ? (
          <Text variant="body" color="danger" style={{ textAlign: 'center' }}>
            {state.message}
          </Text>
        ) : state.kind === 'linked' ? (
          <Text variant="body" color="secondary">
            Linked! Opening InvolveMe…
          </Text>
        ) : (
          <Text variant="body" color="secondary">
            Generating code…
          </Text>
        )}
      </View>
    </Animated.View>
  );

  return (
    <Screen style={styles.root}>
      <AppHeader
        title="InvolveMe"
        brand
        logo
        rightSlot={
          <Pressable
            onPress={() => setDownloadSheetVisible(true)}
            hitSlop={8}
            accessibilityRole="button"
            style={[
              styles.downloadPill,
              { backgroundColor: colors.brandPrimary, borderRadius: radius.pill },
            ]}
          >
            <Text variant="caption" color="inverse" style={{ fontWeight: '600' }}>
              Download
            </Text>
          </Pressable>
        }
        menuItems={[
          {
            label: 'How it works',
            onPress: () => void Linking.openURL(`${MARKETING_URL}/how-it-works`),
          },
          {
            label: 'Privacy Policy',
            onPress: () => void Linking.openURL(`${MARKETING_URL}/legal/privacy`),
          },
          {
            label: 'Terms of Service',
            onPress: () => void Linking.openURL(`${MARKETING_URL}/legal/terms`),
          },
        ]}
      />
      <ActionSheet
        visible={downloadSheetVisible}
        onClose={() => setDownloadSheetVisible(false)}
        title="Get InvolveMe"
        actions={[
          { label: 'Install this web app', onPress: () => void handleInstallWebApp() },
          { label: 'Get the Android app', onPress: handleOpenAndroidDownload },
        ]}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Two slow-floating tint blobs behind everything — purely
            decorative "lively" ambience, never intercepts touches. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.blob,
            blobOneStyle,
            { backgroundColor: colors.brandPrimary, top: -60, left: -60 },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            styles.blob,
            blobTwoStyle,
            { backgroundColor: colors.accentCredit, top: 120, right: -80 },
          ]}
        />

        <View style={[styles.container, isWide ? styles.containerWide : null]}>
          {heroBlock}
          {qrCard}
        </View>

        <WebFooter marketingUrl={MARKETING_URL} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 0 },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 40,
    paddingHorizontal: 16,
    paddingVertical: 48,
  },
  containerWide: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 72,
    maxWidth: 1100,
    alignSelf: 'center',
    width: '100%',
  },
  hero: { alignItems: 'center', gap: 16, maxWidth: 420 },
  heroWide: { alignItems: 'flex-start', maxWidth: 440, gap: 20 },
  heroTitle: { textAlign: 'left' },
  heroTitleNarrow: { textAlign: 'center', fontSize: 34, lineHeight: 40 },
  heroSubtitle: { maxWidth: 380 },
  steps: { marginTop: 8 },
  card: { borderWidth: 1, width: '100%', maxWidth: 360, alignItems: 'center' },
  qrWrap: { minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 },
  countdown: { flexDirection: 'row', alignItems: 'center' },
  downloadPill: { paddingHorizontal: 14, paddingVertical: 8 },
  blob: {
    position: 'absolute',
    width: 260,
    height: 260,
    borderRadius: 260,
    opacity: 0.08,
  },
});
