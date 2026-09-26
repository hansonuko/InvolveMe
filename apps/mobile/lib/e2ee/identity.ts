// Real end-to-end encryption, step 5 (docs/21-E2EE-TECHNICAL-DESIGN.md §5)
//
// Per-device identity: an Ed25519 signing keypair + an X25519 ECDH
// keypair, generated once per device on first E2EE setup and persisted in
// expo-secure-store (iOS Keychain / Android Keystore) — never uploaded,
// never reaches this app's own server in any form beyond the PUBLIC
// halves register-e2ee-device sends. Losing this (app reinstall, device
// reset) means losing the ability to decrypt past sessions with it —
// expected and unavoidable for real E2EE, not a bug to work around.

import * as SecureStore from 'expo-secure-store';

import { base64ToBytes, bytesToBase64 } from './bytes';
import { nativeSodiumProvider as sodium } from './sodiumProviderNative';
import type { KeyPair } from './sodiumProvider';

const IDENTITY_KEY = 'e2ee_identity_v1';

export interface StoredIdentity {
  identityEd25519: KeyPair;
  identityX25519: KeyPair;
}

interface SerializedIdentity {
  edPub: string;
  edPriv: string;
  xPub: string;
  xPriv: string;
}

function serialize(identity: StoredIdentity): string {
  const payload: SerializedIdentity = {
    edPub: bytesToBase64(identity.identityEd25519.publicKey),
    edPriv: bytesToBase64(identity.identityEd25519.privateKey),
    xPub: bytesToBase64(identity.identityX25519.publicKey),
    xPriv: bytesToBase64(identity.identityX25519.privateKey),
  };
  return JSON.stringify(payload);
}

function deserialize(raw: string): StoredIdentity {
  const parsed = JSON.parse(raw) as SerializedIdentity;
  return {
    identityEd25519: {
      publicKey: base64ToBytes(parsed.edPub),
      privateKey: base64ToBytes(parsed.edPriv),
    },
    identityX25519: {
      publicKey: base64ToBytes(parsed.xPub),
      privateKey: base64ToBytes(parsed.xPriv),
    },
  };
}

let cached: StoredIdentity | null = null;

/**
 * Returns this device's identity keypairs, generating and persisting them
 * on first call. Safe to call repeatedly — subsequent calls return the
 * same identity (from an in-memory cache, then SecureStore, only
 * generating fresh keys if neither has one yet).
 */
export async function getOrCreateIdentity(): Promise<StoredIdentity> {
  if (cached) return cached;

  await sodium.ready();

  const existing = await SecureStore.getItemAsync(IDENTITY_KEY);
  if (existing) {
    cached = deserialize(existing);
    return cached;
  }

  const identity: StoredIdentity = {
    identityEd25519: sodium.generateEd25519KeyPair(),
    identityX25519: sodium.generateX25519KeyPair(),
  };
  await SecureStore.setItemAsync(IDENTITY_KEY, serialize(identity));
  cached = identity;
  return identity;
}

/** True once this device has ever generated an identity — used to decide whether E2EE setup still needs to run before a thread can be enabled. */
export async function hasIdentity(): Promise<boolean> {
  if (cached) return true;
  return (await SecureStore.getItemAsync(IDENTITY_KEY)) !== null;
}
