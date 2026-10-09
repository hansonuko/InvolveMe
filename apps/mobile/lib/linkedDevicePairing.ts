import * as Linking from 'expo-linking';

import { callPublicEdgeFunction } from '@/lib/edgeFunctions';

/**
 * docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 4 — the web client's half
 * of the QR-pairing handshake. Wraps `create-device-pairing`/
 * `get-device-pairing-status` (M2), both public/unauthenticated — no
 * session exists yet on this device, that's the entire reason this flow
 * exists.
 */

export interface DevicePairing {
  pairing_id: string;
  expires_at: string;
}

export type DevicePairingStatus =
  | { status: 'pending' | 'expired' | 'already_delivered' }
  | { status: 'confirmed'; access_token: string; refresh_token: string };

export function createDevicePairing(deviceLabel: string, platform?: string) {
  return callPublicEdgeFunction<DevicePairing>('create-device-pairing', {
    device_label: deviceLabel,
    platform,
  });
}

export function getDevicePairingStatus(pairingId: string) {
  return callPublicEdgeFunction<DevicePairingStatus>('get-device-pairing-status', {
    pairing_id: pairingId,
  });
}

/**
 * The QR payload: `involveme`'s own already-registered URL scheme
 * (`app.json`), per the approved implementation plan — not a bare UUID, so
 * the OS camera app could in principle open this app directly too, a free
 * side-benefit of this choice.
 */
export function buildDevicePairingDeepLink(pairingId: string): string {
  return `involveme://link-device?pid=${pairingId}`;
}

/**
 * The mobile scanner's half of the above — decodes a raw QR scan result
 * back into a `pairing_id`. Returns `null` for anything that isn't this
 * app's own pairing link (a QR code pointing somewhere else entirely, or
 * garbage), so the scanner screen can show "not a valid InvolveMe code"
 * instead of crashing on a malformed URL.
 */
export function parseDevicePairingDeepLink(scanned: string): string | null {
  // expo-linking, not a raw `new URL(...)` parse — this file is shared
  // between the web pairing screen and the native scanner, and `URL` has
  // no guaranteed-polyfilled behavior on native RN the way it does in a
  // browser; `Linking.parse` is the one deep-link parser this app already
  // trusts on both platforms (expo-router itself depends on it).
  let parsed: Linking.ParsedURL;
  try {
    parsed = Linking.parse(scanned);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'link-device') return null;
  const pid = parsed.queryParams?.pid;
  return typeof pid === 'string' && pid.length > 0 ? pid : null;
}

/**
 * Best-effort device label for the phone's confirm screen to show (e.g.
 * "Chrome on Windows") — cosmetic only, never trusted for anything
 * security-relevant. `navigator` only exists on web; callers of this file
 * are themselves web-only (Platform.OS === 'web'-gated), but this stays
 * defensive since it's cheap to.
 */
export function describeWebDevice(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let os = 'a computer';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';

  return `${browser} on ${os}`;
}
