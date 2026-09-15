import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { callEdgeFunction } from '@/lib/edgeFunctions';

/**
 * Fraud-infra device fingerprinting (docs/06-SECURITY-FRAUD-LOOPHOLES.md
 * §2) — a stable per-install identifier, hashed on-device before it ever
 * reaches the network, so a shared identifier between two accounts can be
 * detected server-side (supabase/migrations/20260915090000_device_
 * fingerprinting.sql) without this app ever storing or transmitting a raw
 * hardware id. Same "hash before it leaves the device" posture
 * KYC_HASH_PEPPER already establishes for BVN/NIN.
 *
 * Android: `Application.getAndroidId()` (sync, per-app-signing-key +
 * user + device — the value Android itself documents as the
 * fingerprinting-resistant replacement for the old device-wide IMEI/serial
 * approach). iOS: `Application.getIosIdForVendorAsync()` (per-vendor, can
 * resolve `null` on a genuine transient OS condition — see its own doc
 * comment — handled as "nothing to register yet," not an error).
 */
async function getRawDeviceIdentifier(): Promise<string | null> {
  if (Platform.OS === 'android') {
    return Application.getAndroidId();
  }
  if (Platform.OS === 'ios') {
    return await Application.getIosIdForVendorAsync();
  }
  return null;
}

/** Called once per session, same place/pattern as
 * lib/push.ts's resyncPushTokenIfPermitted — see app/_layout.tsx. Every
 * external call in here is guarded: this app's own blank-screen crash
 * investigation this session found an unguarded native-module call on
 * exactly this kind of automatic, silent startup path already once. */
export async function registerDeviceFingerprint(): Promise<void> {
  if (!Device.isDevice) return; // simulators have no stable real identifier worth linking

  try {
    const raw = await getRawDeviceIdentifier();
    if (!raw) return;

    const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw);
    await callEdgeFunction('register-device-fingerprint', { fingerprint_hash: hash });
  } catch (e) {
    console.error('registerDeviceFingerprint failed:', e);
  }
}
