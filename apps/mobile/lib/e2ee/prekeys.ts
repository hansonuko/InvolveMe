// Real end-to-end encryption, step 5 (docs/21-E2EE-TECHNICAL-DESIGN.md §3,
// §5) — signed/one-time prekey generation, registration, and local
// storage of their PRIVATE halves (the server only ever receives and
// stores the public halves; responding to an incoming X3DH handshake
// needs this device's own signed-prekey and one-time-prekey private keys,
// which only ever exist here).
//
// One-time prekeys are stored one-per-SecureStore-key (`e2ee_otp_<id>`),
// not as a single JSON array, deliberately: SecureStore has a real,
// platform-enforced per-value size ceiling (a few KB), and this app has
// no on-device way to verify that ceiling from this Node-only development
// session — storing N prekeys as one growing blob risks silently hitting
// it as the pool grows; storing each individually keeps every value small
// and constant-size regardless of how large the pool gets. `e2ee_otp_
// index_v1` tracks which ids currently exist (SecureStore has no "list
// keys" API), and is itself small (a JSON array of small integers).

import * as SecureStore from 'expo-secure-store';

import { callEdgeFunction } from '@/lib/edgeFunctions';

import { base64ToBytes, bytesToBase64 } from './bytes';
import { getOrCreateIdentity } from './identity';
import { nativeSodiumProvider as sodium } from './sodiumProviderNative';

const DEVICE_ID_KEY = 'e2ee_device_id_v1';
const SIGNED_PREKEY_KEY = 'e2ee_signed_prekey_v1';
const OTP_INDEX_KEY = 'e2ee_otp_index_v1';
const otpStorageKey = (keyId: number) => `e2ee_otp_${keyId}`;

const SIGNED_PREKEY_VALIDITY_DAYS = 30;
const INITIAL_ONE_TIME_PREKEY_COUNT = 10;
const REPLENISH_THRESHOLD = 3;
const REPLENISH_BATCH = 10;

interface SignedPrekeyRecord {
  keyId: number;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  signature: Uint8Array;
  expiresAt: string;
}

interface SerializedSignedPrekey {
  keyId: number;
  pub: string;
  priv: string;
  sig: string;
  expiresAt: string;
}

interface SerializedOneTimePrekey {
  pub: string;
  priv: string;
}

async function loadSignedPrekey(): Promise<SignedPrekeyRecord | null> {
  const raw = await SecureStore.getItemAsync(SIGNED_PREKEY_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as SerializedSignedPrekey;
  return {
    keyId: parsed.keyId,
    publicKey: base64ToBytes(parsed.pub),
    privateKey: base64ToBytes(parsed.priv),
    signature: base64ToBytes(parsed.sig),
    expiresAt: parsed.expiresAt,
  };
}

async function saveSignedPrekey(record: SignedPrekeyRecord): Promise<void> {
  const serialized: SerializedSignedPrekey = {
    keyId: record.keyId,
    pub: bytesToBase64(record.publicKey),
    priv: bytesToBase64(record.privateKey),
    sig: bytesToBase64(record.signature),
    expiresAt: record.expiresAt,
  };
  await SecureStore.setItemAsync(SIGNED_PREKEY_KEY, JSON.stringify(serialized));
}

async function loadOtpIndex(): Promise<number[]> {
  const raw = await SecureStore.getItemAsync(OTP_INDEX_KEY);
  return raw ? (JSON.parse(raw) as number[]) : [];
}

async function saveOtpIndex(ids: number[]): Promise<void> {
  await SecureStore.setItemAsync(OTP_INDEX_KEY, JSON.stringify(ids));
}

interface GeneratedOneTimePrekey {
  keyId: number;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

async function generateAndStoreOneTimePrekeys(
  count: number,
  startKeyId: number,
): Promise<GeneratedOneTimePrekey[]> {
  const generated: GeneratedOneTimePrekey[] = [];
  for (let i = 0; i < count; i++) {
    const keyId = startKeyId + i;
    const { publicKey, privateKey } = sodium.generateX25519KeyPair();
    const serialized: SerializedOneTimePrekey = {
      pub: bytesToBase64(publicKey),
      priv: bytesToBase64(privateKey),
    };
    await SecureStore.setItemAsync(otpStorageKey(keyId), JSON.stringify(serialized));
    generated.push({ keyId, publicKey, privateKey });
  }

  const index = await loadOtpIndex();
  await saveOtpIndex([...index, ...generated.map((g) => g.keyId)]);

  return generated;
}

/**
 * Registers this device with the server: identity keys (already
 * persisted by identity.ts), a fresh signed prekey, and an initial
 * one-time prekey batch. Idempotent — a second call is a no-op if a
 * signed prekey is already stored locally (register-e2ee-device isn't
 * designed to be called twice for the same device).
 */
export async function ensureDeviceRegistered(deviceLabel?: string): Promise<void> {
  const existing = await loadSignedPrekey();
  if (existing) return;

  await sodium.ready();
  const identity = await getOrCreateIdentity();

  const signedPrekeyKeyPair = sodium.generateX25519KeyPair();
  const signature = sodium.sign(signedPrekeyKeyPair.publicKey, identity.identityEd25519.privateKey);
  const expiresAt = new Date(
    Date.now() + SIGNED_PREKEY_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const signedPrekeyId = 1;

  const oneTimePrekeys = await generateAndStoreOneTimePrekeys(INITIAL_ONE_TIME_PREKEY_COUNT, 1);

  const { device_id: deviceId } = await callEdgeFunction<{ device_id: string }>(
    'register-e2ee-device',
    {
      device_label: deviceLabel,
      identity_key_ed25519: bytesToBase64(identity.identityEd25519.publicKey),
      identity_key_x25519: bytesToBase64(identity.identityX25519.publicKey),
      signed_prekey_id: signedPrekeyId,
      signed_prekey_public: bytesToBase64(signedPrekeyKeyPair.publicKey),
      signed_prekey_signature: bytesToBase64(signature),
      signed_prekey_expires_at: expiresAt,
      one_time_prekeys: oneTimePrekeys.map((p) => ({
        key_id: p.keyId,
        public_key: bytesToBase64(p.publicKey),
      })),
    },
  );
  await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);

  await saveSignedPrekey({
    keyId: signedPrekeyId,
    publicKey: signedPrekeyKeyPair.publicKey,
    privateKey: signedPrekeyKeyPair.privateKey,
    signature,
    expiresAt,
  });
}

export async function getSignedPrekey(): Promise<SignedPrekeyRecord | null> {
  return loadSignedPrekey();
}

export async function getOwnDeviceId(): Promise<string | null> {
  return SecureStore.getItemAsync(DEVICE_ID_KEY);
}

/**
 * Looks up (and removes — one-time prekeys are single-use, matching the
 * server's own atomic-consume-on-fetch design in fn_fetch_prekey_bundles)
 * the private half of a one-time prekey this device published, by the id
 * a peer's X3DH handshake says it consumed. Returns null if this device
 * has no local record of that id — either it was never published, or a
 * previous handshake already consumed and deleted it (fn_fetch_prekey_
 * bundles guarantees the server itself never hands out the same id
 * twice, so this should not happen in practice; null is handled as
 * "degraded, no one-time term" by x3dh.ts's responder path either way).
 */
export async function takeLocalOneTimePrekey(keyId: number): Promise<Uint8Array | null> {
  const raw = await SecureStore.getItemAsync(otpStorageKey(keyId));
  if (!raw) return null;

  const parsed = JSON.parse(raw) as SerializedOneTimePrekey;
  await SecureStore.deleteItemAsync(otpStorageKey(keyId));
  const index = await loadOtpIndex();
  await saveOtpIndex(index.filter((id) => id !== keyId));

  return base64ToBytes(parsed.priv);
}

/**
 * Tops up the local one-time-prekey pool once it runs low. Call this
 * after every successful handshake completion (a natural, low-frequency
 * checkpoint) rather than on a timer — no server-side "you're running
 * low" push exists (matching replenish-one-time-prekeys' own header
 * comment: the client already knows its own remaining count).
 */
export async function replenishOneTimePrekeysIfLow(): Promise<void> {
  const index = await loadOtpIndex();
  if (index.length > REPLENISH_THRESHOLD) return;

  const deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!deviceId) return; // not registered yet — nothing to replenish against

  const nextKeyId = index.length ? Math.max(...index) + 1 : 1;
  const generated = await generateAndStoreOneTimePrekeys(REPLENISH_BATCH, nextKeyId);

  await callEdgeFunction('replenish-one-time-prekeys', {
    device_id: deviceId,
    one_time_prekeys: generated.map((p) => ({
      key_id: p.keyId,
      public_key: bytesToBase64(p.publicKey),
    })),
  }).catch(async () => {
    // The server call failed after local generation/storage already
    // committed — undo the local side so the next low-pool check retries
    // cleanly instead of believing prekeys exist server-side that don't.
    for (const p of generated) {
      await SecureStore.deleteItemAsync(otpStorageKey(p.keyId));
    }
    await saveOtpIndex(index);
    throw new Error(
      'replenishOneTimePrekeysIfLow: server call failed, local generation rolled back.',
    );
  });
}
