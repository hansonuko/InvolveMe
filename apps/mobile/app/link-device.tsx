import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { withAppLockSuppressed } from '@/lib/appLock';
import { EdgeFunctionError } from '@/lib/edgeFunctions';
import { parseDevicePairingDeepLink } from '@/lib/linkedDevicePairing';
import { useConfirmDevicePairing } from '@/lib/queries/linkedDevices';
import { showAlert } from '@/lib/ui/alert';
import { useTheme } from '@/theme';

/**
 * docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 5 — the scanning half of
 * the QR-pairing handshake, run from whichever device already holds a real
 * primary account: native, or (session 45 continued) `app.involvemechat.com`
 * — reached from the chats screen's overflow menu ("Link a device"), gated
 * there on `Platform.OS !== 'web' || isFullPwaHost()`. `web.involvemechat.com`
 * never reaches this screen — it's the thing being linked, not the one doing
 * the linking. `CameraView`/`useCameraPermissions` already have real web
 * implementations (`getUserMedia` + the browser's own barcode detection,
 * falling back to a pure-JS polyfill where unavailable — confirmed in
 * `expo-camera`'s own source before relying on it, not assumed), so no
 * platform branching was needed in this file itself. Scans a QR code
 * rendered by `involveme-web`'s pairing screen (M4), decodes it back to a
 * `pairing_id`, confirms with the user, then calls `confirm-device-pairing`
 * — the companion device's own `get-device-pairing-status` poll picks up
 * the result from there, no further action needed on this screen.
 */
export default function LinkDeviceScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const confirmPairing = useConfirmDevicePairing();
  const cameraWrapRef = useRef<View>(null);

  // Found investigating a real report (session 45 continued): on web,
  // expo-camera's own `getUserMedia` call (`WebCameraUtils.getIdealConstraints`,
  // confirmed by reading that source, not assumed) requests no explicit
  // resolution or focus mode at all — just a bare `facingMode` constraint
  // — so the browser picks its own default, which is frequently too
  // low-res and/or fixed-focus to resolve a QR code's fine detail at
  // comfortable scanning distance. `CameraView` has no public prop for
  // this on web; the only way to request better is to reach the real
  // `MediaStreamTrack` the library already created and ask the browser to
  // reconfigure it directly — a legitimate `getUserMedia`-track API, not
  // a library patch. Best-effort only: wrapped so a device/browser that
  // rejects these constraints just keeps whatever it already had.
  const sharpenWebCameraStream = () => {
    if (Platform.OS !== 'web') return;
    // `onCameraReady` fires the instant the stream is set in React state,
    // one render ahead of the separate effect that actually assigns it to
    // the real `<video>` element's `srcObject` — querying the DOM
    // synchronously here can run before that commits. A double rAF (the
    // same margin `useLoadedVideo` in expo-camera's own source gives
    // itself after `loadedmetadata`, for the same reason) reliably lands
    // after it.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = cameraWrapRef.current as unknown as HTMLElement | null;
        const video = container?.querySelector<HTMLVideoElement>('video');
        const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0];
        if (!track) return;
        void track
          .applyConstraints({
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          })
          .catch(() => {
            // Not every browser/camera supports focusMode as a constraint
            // (Safari notably doesn't) — falling back to whatever the
            // default stream already was is correct, not an error worth
            // surfacing.
          });
      });
    });
  };

  const handleBarcodeScanned = (result: { data: string }) => {
    if (scanned || confirmPairing.isPending) return;

    const pairingId = parseDevicePairingDeepLink(result.data);
    if (!pairingId) {
      // A real barcode WAS detected, it just isn't this app's own pairing
      // link — surface that once (same `scanned` guard as a real match
      // below, reset on dismiss) instead of silently ignoring forever.
      // This is the one signal that distinguishes "camera can't read this
      // QR" from "camera isn't detecting anything at all" — the latter
      // never reaches this line, this branch only runs when the scanner
      // genuinely decoded *something*.
      setScanned(true);
      showAlert('Not an InvolveMe code', `Scanned: ${result.data.slice(0, 80)}`, [
        { text: 'OK', onPress: () => setScanned(false) },
      ]);
      return;
    }

    setScanned(true);
    showAlert('Link this device?', 'A browser will get full access to your InvolveMe account.', [
      { text: 'Cancel', style: 'cancel', onPress: () => setScanned(false) },
      {
        text: 'Link',
        onPress: async () => {
          try {
            await confirmPairing.mutateAsync({ pairingId, platform: Platform.OS });
            showAlert('Device linked', 'The other device should sign in automatically.');
            router.back();
          } catch (e) {
            const message =
              e instanceof EdgeFunctionError ? e.message : 'Could not link that device.';
            showAlert('Could not link device', message);
            setScanned(false);
          }
        },
      },
    ]);
  };

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.flex, { backgroundColor: '#000' }]}>
        {permission?.granted ? (
          <View ref={cameraWrapRef} style={styles.flex}>
            <CameraView
              style={styles.flex}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={handleBarcodeScanned}
              onCameraReady={() => {
                setCameraReady(true);
                sharpenWebCameraStream();
              }}
              onMountError={(e) =>
                showAlert('Camera error', e.message || 'The camera failed to start.')
              }
            />
          </View>
        ) : (
          <View style={[styles.flex, styles.centered]}>
            <Text variant="body" color="inverse" style={{ textAlign: 'center' }}>
              InvolveMe needs camera access to scan a device-linking code.
            </Text>
          </View>
        )}

        {/* Scan frame + instructions overlay — rendered regardless of
            permission state so the "grant access" button below has
            somewhere consistent to live. */}
        <View style={[StyleSheet.absoluteFill, styles.centered]} pointerEvents="box-none">
          <View
            style={[styles.frame, { borderColor: colors.brandPrimary, borderRadius: radius.card }]}
          />
          <Text
            variant="body"
            color="inverse"
            style={{ marginTop: spacing.lg, textAlign: 'center', paddingHorizontal: spacing.xl }}
          >
            Point your camera at the QR code shown on web.involvemechat.com
          </Text>
          {permission?.granted && !cameraReady ? (
            <Text
              variant="caption"
              color="inverse"
              style={{ marginTop: spacing.sm, textAlign: 'center' }}
            >
              Starting camera…
            </Text>
          ) : null}
          {!permission?.granted ? (
            <Button
              label="Grant camera access"
              onPress={() => void withAppLockSuppressed(() => requestPermission())}
              style={{ marginTop: spacing.lg }}
            />
          ) : null}
        </View>

        <SafeAreaView style={styles.closeWrap} edges={['top']}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Ionicons name="close" size={30} color={colors.textInverse} />
          </Pressable>
        </SafeAreaView>
      </View>
    </>
  );
}

const FRAME_SIZE = 240;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  frame: { width: FRAME_SIZE, height: FRAME_SIZE, borderWidth: 3 },
  closeWrap: { position: 'absolute', top: 0, right: 24 },
});
