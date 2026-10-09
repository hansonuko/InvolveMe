import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Ring } from '@/components/ui/Ring';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { EdgeFunctionError } from '@/lib/edgeFunctions';
import {
  buildDevicePairingDeepLink,
  createDevicePairing,
  describeWebDevice,
  getDevicePairingStatus,
} from '@/lib/linkedDevicePairing';
import { supabase } from '@/lib/supabase';
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
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against a stale poll's response landing after this component has
  // already moved on to a new pairing (or unmounted) — same "ignore a
  // response that arrived after we stopped caring" shape useSession's own
  // mount-guard uses elsewhere in this app.
  const pairingIdRef = useRef<string | null>(null);

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

  return (
    <Screen style={styles.container}>
      <View style={styles.hero}>
        <Text variant="display">InvolveMe Web</Text>
        <Text variant="body" color="secondary" style={{ marginTop: spacing.sm }}>
          Use InvolveMe from this browser, linked to your phone.
        </Text>
      </View>

      <View
        style={[
          styles.card,
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

        <View style={{ gap: spacing.sm }}>
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
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { justifyContent: 'center', gap: 32, alignItems: 'center' },
  hero: { alignItems: 'center' },
  card: { borderWidth: 1, width: '100%', maxWidth: 420, alignItems: 'center' },
  qrWrap: { minHeight: 260, alignItems: 'center', justifyContent: 'center', gap: 12 },
  countdown: { flexDirection: 'row', alignItems: 'center' },
});
