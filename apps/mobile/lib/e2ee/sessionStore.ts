// Real end-to-end encryption, step 5 (docs/21-E2EE-TECHNICAL-DESIGN.md §5)
//
// Persists one Double Ratchet session (doubleRatchet.ts's RatchetState)
// per peer device, keyed by that device's id, in expo-secure-store. This
// state is exactly as sensitive as the identity key (docs/21 §5's own
// framing) — it never leaves the device, never reaches the server in any
// form.
//
// skippedMessageKeys is capped at MAX_PERSISTED_SKIPPED entries on write,
// independent of doubleRatchet.ts's own MAX_SKIP (a protocol-level
// compute/DoS bound, not a storage bound) — for the same reason prekeys.ts
// splits one-time prekeys across many small SecureStore values rather
// than one growing blob: this app has no on-device way to verify
// SecureStore's real per-value size ceiling from a Node-only development
// session, so the safe assumption is a small one. A message skipped
// beyond this cap that arrives after the app has since restarted (losing
// the trimmed entries) will fail to decrypt — a real, documented
// trade-off, not a silent gap.

import * as SecureStore from 'expo-secure-store';

import { base64ToBytes, bytesToBase64 } from './bytes';
import type { RatchetState } from './doubleRatchet';

const MAX_PERSISTED_SKIPPED = 25;

const sessionStorageKey = (peerDeviceId: string) => `e2ee_session_${peerDeviceId}`;

interface SerializedRatchetState {
  dhSelfPub: string;
  dhSelfPriv: string;
  dhRemotePub: string | null;
  rootKey: string;
  chainKeySend: string | null;
  chainKeyRecv: string | null;
  sendN: number;
  recvN: number;
  prevChainLen: number;
  skipped: [string, string][];
}

function serialize(state: RatchetState): string {
  const skippedEntries = [...state.skippedMessageKeys.entries()];
  const trimmed = skippedEntries.slice(-MAX_PERSISTED_SKIPPED);

  const payload: SerializedRatchetState = {
    dhSelfPub: bytesToBase64(state.dhSelfPublicKey),
    dhSelfPriv: bytesToBase64(state.dhSelfPrivateKey),
    dhRemotePub: state.dhRemotePublicKey ? bytesToBase64(state.dhRemotePublicKey) : null,
    rootKey: bytesToBase64(state.rootKey),
    chainKeySend: state.chainKeySend ? bytesToBase64(state.chainKeySend) : null,
    chainKeyRecv: state.chainKeyRecv ? bytesToBase64(state.chainKeyRecv) : null,
    sendN: state.sendMessageNumber,
    recvN: state.recvMessageNumber,
    prevChainLen: state.previousSendChainLength,
    skipped: trimmed.map(([k, v]) => [k, bytesToBase64(v)]),
  };
  return JSON.stringify(payload);
}

function deserialize(raw: string): RatchetState {
  const parsed = JSON.parse(raw) as SerializedRatchetState;
  return {
    dhSelfPublicKey: base64ToBytes(parsed.dhSelfPub),
    dhSelfPrivateKey: base64ToBytes(parsed.dhSelfPriv),
    dhRemotePublicKey: parsed.dhRemotePub ? base64ToBytes(parsed.dhRemotePub) : null,
    rootKey: base64ToBytes(parsed.rootKey),
    chainKeySend: parsed.chainKeySend ? base64ToBytes(parsed.chainKeySend) : null,
    chainKeyRecv: parsed.chainKeyRecv ? base64ToBytes(parsed.chainKeyRecv) : null,
    sendMessageNumber: parsed.sendN,
    recvMessageNumber: parsed.recvN,
    previousSendChainLength: parsed.prevChainLen,
    skippedMessageKeys: new Map(parsed.skipped.map(([k, v]) => [k, base64ToBytes(v)])),
  };
}

export async function loadSession(peerDeviceId: string): Promise<RatchetState | null> {
  const raw = await SecureStore.getItemAsync(sessionStorageKey(peerDeviceId));
  return raw ? deserialize(raw) : null;
}

export async function saveSession(peerDeviceId: string, state: RatchetState): Promise<void> {
  await SecureStore.setItemAsync(sessionStorageKey(peerDeviceId), serialize(state));
}

export async function deleteSession(peerDeviceId: string): Promise<void> {
  await SecureStore.deleteItemAsync(sessionStorageKey(peerDeviceId));
}
