import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
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
 * docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 5 — the phone's half of
 * the QR-pairing handshake. Reached from the chats screen's overflow menu
 * ("Link a device"). Scans a QR code rendered by `involveme-web`'s pairing
 * screen (M4), decodes it back to a `pairing_id`, confirms with the user,
 * then calls `confirm-device-pairing` — the companion device's own
 * `get-device-pairing-status` poll picks up the result from there, no
 * further action needed on this screen.
 */
export default function LinkDeviceScreen() {
  const { colors, spacing, radius } = useTheme();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const confirmPairing = useConfirmDevicePairing();

  const handleBarcodeScanned = (result: { data: string }) => {
    if (scanned || confirmPairing.isPending) return;

    const pairingId = parseDevicePairingDeepLink(result.data);
    if (!pairingId) {
      // Not this app's own pairing link — ignore and keep scanning rather
      // than interrupting with an alert for every random QR code pointed
      // at the camera (posters, other apps' codes, etc.).
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
          <CameraView
            style={styles.flex}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handleBarcodeScanned}
          />
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
            Point your camera at the QR code shown on involveme.net
          </Text>
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
