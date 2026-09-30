// Real end-to-end encryption, step 5 (docs/21-E2EE-TECHNICAL-DESIGN.md §5)
//
// The one clean interface (`encryptForThread` / `decryptEnvelope`) docs/21
// §5 calls for — everything above this (messages.ts) only ever calls
// these two functions, never touches x3dh.ts/doubleRatchet.ts/
// sessionStore.ts directly. If this app ever gets real native-build
// tooling and wants to swap the ratchet internals for a bridge to
// Signal's actual audited libsignal-client, that's a contained swap
// behind this file, not a rewrite of the caller.
//
// Single-device-per-user scope note: e2ee_message_envelopes has no
// sender-device-id column (docs/21 §2's schema) — a logical message
// carries one row per RECIPIENT device, and the sender is only identified
// by messages.sender_id (a user, not a device). This module resolves "the
// sender's device" by querying that user's currently-registered, active
// e2ee_devices row and assuming there is exactly one — correct today
// (linked devices, docs/12, isn't built yet) and the one place a future
// multi-device client would need to change: everything else here
// (per-device ratchet sessions, per-device envelopes) is already
// structured for more than one device per user.

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

import { bytesToBase64, base64ToBytes, hexToBytes } from './bytes';
import { withDeviceLock } from './deviceLock';
import {
  initRatchetAsAlice,
  initRatchetAsBob,
  ratchetDecrypt,
  ratchetEncrypt,
} from './doubleRatchet';
import { getOrCreateIdentity } from './identity';
import { getCachedPlaintextBatch, setCachedPlaintext } from './plaintextCache';
import {
  getOwnDeviceId,
  getSignedPrekey,
  replenishOneTimePrekeysIfLow,
  takeLocalOneTimePrekey,
} from './prekeys';
import { nativeSodiumProvider as sodium } from './sodiumProviderNative';
import { deleteSession, loadSession, saveSession } from './sessionStore';
import { verifyPrekeyBundle, x3dhInitiate, x3dhRespond, type PrekeyBundle } from './x3dh';

export interface OutgoingEnvelope {
  recipientDeviceId: string;
  ciphertext: string;
  ratchetPublicKey: string;
  previousChainLength: number;
  messageNumber: number;
  x3dhSenderIdentityKey: string | null;
  x3dhSenderEphemeralKey: string | null;
  x3dhOneTimePrekeyId: number | null;
}

export interface IncomingEnvelope {
  ciphertext: string;
  ratchetPublicKey: string;
  previousChainLength: number;
  messageNumber: number;
  x3dhSenderIdentityKey: string | null;
  x3dhSenderEphemeralKey: string | null;
  x3dhOneTimePrekeyId: number | null;
}

const THREAD_ASSOCIATED_DATA_PREFIX = 'InvolveMe-thread:';

function associatedDataFor(threadId: string): Uint8Array {
  return new TextEncoder().encode(`${THREAD_ASSOCIATED_DATA_PREFIX}${threadId}`);
}

async function getActiveDeviceIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('e2ee_devices')
    .select('id')
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (error) throw error;
  return (data ?? []).map((d) => d.id as string);
}

interface FetchedBundle {
  device_id: string;
  identity_key_ed25519: string;
  identity_key_x25519: string;
  signed_prekey_id: number;
  signed_prekey_public: string;
  signed_prekey_signature: string;
  one_time_prekey_id: number | null;
  one_time_prekey_public: string | null;
}

async function fetchPrekeyBundles(recipientUserId: string): Promise<FetchedBundle[]> {
  const { bundles } = await callEdgeFunction<{ bundles: FetchedBundle[] }>('fetch-prekey-bundles', {
    target_user_id: recipientUserId,
  });
  return bundles;
}

async function bootstrapOutgoingSession(
  recipientUserId: string,
  bundle: FetchedBundle,
): Promise<{ sessionInit: ReturnType<typeof x3dhInitiate>; oneTimePrekeyId: number | null }> {
  const identity = await getOrCreateIdentity();

  const prekeyBundle: PrekeyBundle = {
    identityKeyEd25519: base64ToBytes(bundle.identity_key_ed25519),
    identityKeyX25519: base64ToBytes(bundle.identity_key_x25519),
    signedPrekeyPublic: base64ToBytes(bundle.signed_prekey_public),
    signedPrekeySignature: base64ToBytes(bundle.signed_prekey_signature),
    oneTimePrekeyPublic: bundle.one_time_prekey_public
      ? base64ToBytes(bundle.one_time_prekey_public)
      : null,
  };
  verifyPrekeyBundle(sodium, prekeyBundle);

  const sessionInit = x3dhInitiate(sodium, identity.identityX25519.privateKey, prekeyBundle);
  return {
    sessionInit,
    oneTimePrekeyId: prekeyBundle.oneTimePrekeyPublic ? bundle.one_time_prekey_id : null,
  };
}

/**
 * Encrypts `plaintext` for every one of `recipientUserId`'s active
 * devices, bootstrapping an X3DH session for any device that doesn't
 * already have one. Returns one envelope per device, ready to send as
 * `p_envelopes` to fn_send_message/fn_edit_message.
 */
export async function encryptForThread(
  threadId: string,
  recipientUserId: string,
  plaintext: string,
): Promise<OutgoingEnvelope[]> {
  await sodium.ready();
  const identity = await getOrCreateIdentity();
  const signedPrekey = await getSignedPrekey();
  if (!signedPrekey) {
    throw new Error('encryptForThread: this device has not completed E2EE setup yet.');
  }

  const deviceIds = await getActiveDeviceIds(recipientUserId);
  if (deviceIds.length === 0) {
    throw new Error('encryptForThread: recipient has no active E2EE device.');
  }

  // Heuristic only, to decide whether fetch-prekey-bundles is worth
  // calling at all — NOT the authority on whether a given device still
  // needs bootstrapping by the time its own locked section below
  // actually runs (a concurrent call could have already bootstrapped it
  // in between; that section re-reads fresh, under its own device's
  // lock, and is what's actually trusted).
  const deviceIdsLikelyNeedingBootstrap: string[] = [];
  for (const deviceId of deviceIds) {
    if (!(await loadSession(threadId, deviceId))) deviceIdsLikelyNeedingBootstrap.push(deviceId);
  }

  let bundlesByDeviceId = new Map<string, FetchedBundle>();
  if (deviceIdsLikelyNeedingBootstrap.length > 0) {
    const bundles = await fetchPrekeyBundles(recipientUserId);
    bundlesByDeviceId = new Map(bundles.map((b) => [b.device_id, b]));
  }

  const ad = associatedDataFor(threadId);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const envelopes: OutgoingEnvelope[] = [];

  // Each device's own read-ratchet-write sequence is serialized against
  // any OTHER concurrent call (another send, a retry) touching the same
  // device — see deviceLock.ts's header comment for the real race this
  // closes. Different devices still proceed independently/concurrently;
  // this only ever blocks two callers wanting the SAME device.
  for (const deviceId of deviceIds) {
    const bundle = bundlesByDeviceId.get(deviceId);

    const outcome = await withDeviceLock(`${threadId}:${deviceId}`, async () => {
      let x3dhFields: {
        x3dhSenderIdentityKey: string | null;
        x3dhSenderEphemeralKey: string | null;
        x3dhOneTimePrekeyId: number | null;
      } = { x3dhSenderIdentityKey: null, x3dhSenderEphemeralKey: null, x3dhOneTimePrekeyId: null };

      // Fresh read, inside this device's lock — the only read this
      // function actually trusts for "does a session already exist."
      let session = await loadSession(threadId, deviceId);

      if (!session) {
        if (!bundle) {
          // The device existed when we listed active devices a moment
          // ago but published no usable bundle (e.g. its signed prekey
          // expired server-side in between), or a concurrent call
          // claimed the last one-time prekey and this call's own
          // pre-fetch heuristic didn't anticipate needing one — skip it
          // rather than fail the whole send; the other devices still
          // get a real envelope.
          return null;
        }
        const { sessionInit, oneTimePrekeyId } = await bootstrapOutgoingSession(
          recipientUserId,
          bundle,
        );
        session = initRatchetAsAlice(
          sodium,
          sessionInit.rootKey,
          base64ToBytes(bundle.signed_prekey_public),
        );
        x3dhFields = {
          x3dhSenderIdentityKey: bytesToBase64(identity.identityX25519.publicKey),
          x3dhSenderEphemeralKey: bytesToBase64(sessionInit.ephemeralPublicKey),
          x3dhOneTimePrekeyId: oneTimePrekeyId,
        };
      }

      const encrypted = ratchetEncrypt(sodium, session, plaintextBytes, ad);
      await saveSession(threadId, deviceId, encrypted.nextState);
      return { encrypted, x3dhFields };
    });

    if (!outcome) continue;
    envelopes.push({
      recipientDeviceId: deviceId,
      ciphertext: bytesToBase64(outcome.encrypted.ciphertext),
      ratchetPublicKey: bytesToBase64(outcome.encrypted.header.ratchetPublicKey),
      previousChainLength: outcome.encrypted.header.previousChainLength,
      messageNumber: outcome.encrypted.header.messageNumber,
      ...outcome.x3dhFields,
    });
  }

  if (envelopes.length === 0) {
    throw new Error('encryptForThread: no recipient device could be reached.');
  }

  void replenishOneTimePrekeysIfLow().catch(() => {
    // Best-effort — a failed top-up here just means the next send tries
    // again; it must never block or fail the message that's actually
    // being sent right now.
  });

  return envelopes;
}

/**
 * Decrypts an envelope addressed to this device, from `senderUserId`.
 * Bootstraps the receiving side of a new X3DH session if the envelope
 * carries session-establishing fields AND no session already exists for
 * that sender device (docs/21 §2: session-establishing fields are meant
 * to appear only on the first message of a brand-new session — but a
 * REDELIVERED copy of that same original message, entirely plausible
 * under normal at-least-once delivery/reconnect behavior, would still
 * carry them. Without the "no session already exists" guard, re-processing
 * that redelivery would blindly reset an already-advanced session back to
 * its pre-conversation state, desyncing it from whatever the sender's
 * side has actually moved on to since — found by this project's own
 * adversarial review (docs/21 §7), reproduced live, not theoretical).
 * If a session already exists, x3dh fields on this envelope are ignored
 * and decryption proceeds against the existing session — the normal
 * skipped-key-cache and ratchet-key-comparison logic in doubleRatchet.ts
 * already handles a genuine redelivery of an already-processed message
 * safely (fails closed with an AEAD auth error rather than corrupting
 * state), so this doesn't need its own separate replay-detection.
 *
 * This device's whole read-ratchet-write sequence for `senderDeviceId` is
 * serialized against any other concurrent call touching the same device
 * (see deviceLock.ts) — the other half of the race the same review found:
 * two overlapping decrypts for the same sender could otherwise let the
 * losing call's stale-based state overwrite the winning call's, resurrecting
 * an already-consumed (and supposedly discarded) message key on disk.
 */
export async function decryptEnvelope(
  threadId: string,
  senderUserId: string,
  envelope: IncomingEnvelope,
): Promise<string> {
  await sodium.ready();

  const senderDeviceIds = await getActiveDeviceIds(senderUserId);
  const senderDeviceId = senderDeviceIds[0];
  if (!senderDeviceId) {
    throw new Error('decryptEnvelope: sender has no active E2EE device on record.');
  }

  const ad = associatedDataFor(threadId);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  const header = {
    ratchetPublicKey: base64ToBytes(envelope.ratchetPublicKey),
    previousChainLength: envelope.previousChainLength,
    messageNumber: envelope.messageNumber,
  };

  return withDeviceLock(`${threadId}:${senderDeviceId}`, async () => {
    let session = await loadSession(threadId, senderDeviceId);

    if (!session && envelope.x3dhSenderIdentityKey && envelope.x3dhSenderEphemeralKey) {
      const identity = await getOrCreateIdentity();
      const signedPrekey = await getSignedPrekey();
      if (!signedPrekey) {
        throw new Error('decryptEnvelope: this device has not completed E2EE setup yet.');
      }

      const oneTimePrekeyPrivate = envelope.x3dhOneTimePrekeyId
        ? await takeLocalOneTimePrekey(envelope.x3dhOneTimePrekeyId)
        : null;

      const rootKey = x3dhRespond(sodium, {
        ownIdentityPrivateKeyX25519: identity.identityX25519.privateKey,
        ownSignedPrekeyPrivateKey: signedPrekey.privateKey,
        ownOneTimePrekeyPrivateKey: oneTimePrekeyPrivate,
        peerIdentityPublicKeyX25519: base64ToBytes(envelope.x3dhSenderIdentityKey),
        peerEphemeralPublicKey: base64ToBytes(envelope.x3dhSenderEphemeralKey),
      });

      session = initRatchetAsBob(sodium, rootKey, {
        publicKey: signedPrekey.publicKey,
        privateKey: signedPrekey.privateKey,
      });
    }

    if (!session) {
      throw new Error('decryptEnvelope: no session and no X3DH bootstrap fields on this envelope.');
    }

    try {
      const decrypted = ratchetDecrypt(sodium, session, header, ciphertext, ad);
      await saveSession(threadId, senderDeviceId, decrypted.nextState);
      return new TextDecoder().decode(decrypted.plaintext);
    } catch (e) {
      // Real, live-hit case (not hypothetical): a session bootstrapped
      // before 412ffad ("e2ee had never worked" — missing crypto_
      // scalarmult) derived a garbage root key from the start, so
      // ratchetDecrypt's AEAD auth check fails on every message in that
      // session, forever — a stale/corrupted session never repairs
      // itself, and this function had no path back from it (every
      // message after the poisoned handshake permanently rendered as
      // "Message unavailable", both before and after the crypto fix).
      // ratchetDecrypt only ever throws here for a genuine auth failure
      // or its own "should not happen" invariant (skipped-message/
      // reordering is already handled without throwing — see its own
      // header), never for something a retry could fix — so dropping the
      // session is always the right response, not just a guess. Clearing
      // it here (rather than leaving the corrupted state saved) means the
      // next envelope FROM THIS SENDER DEVICE either gets a proper fresh
      // X3DH bootstrap (if the sender has also reset, see
      // resetSessionWithDevice's own UI trigger) or fails once more and
      // re-triggers this same reset — self-converging within a couple of
      // round-trips instead of wedged forever.
      await deleteSession(threadId, senderDeviceId);
      throw e;
    }
  });
}

interface ThreadMessageRef {
  id: string;
  sender_id: string;
}

/**
 * Resolves plaintext for every body-null message in a thread, oldest
 * first (required — decrypting a device's messages out of order would
 * desync that device's persisted ratchet state from what actually
 * happened). Checks the durable plaintext cache before ever touching an
 * envelope or the ratchet: cache hit means no decryption is attempted at
 * all, which matters because a message's key is gone forever after its
 * first successful decrypt (docs/21 §1) — this function must never
 * accidentally attempt a second decrypt of something already resolved.
 *
 * Messages this device sent itself have no envelope addressed to it at
 * all (docs/21 §2 — envelopes are per RECIPIENT device); those are
 * expected to already be cache-populated by encryptForThread's own
 * caller (useSendMessage caches the plaintext it already has at send
 * time, never decrypts its own sends). A same-sender message missing from
 * the cache is unrecoverable by construction, not a bug to retry.
 *
 * Returns a map from message id to resolved plaintext; a message absent
 * from the result could not be decrypted (already consumed, no envelope
 * found, or a genuinely tampered/corrupt entry) — the caller renders a
 * fallback, never treats absence as a crash.
 */
export async function decryptThreadMessages(
  threadId: string,
  currentUserId: string,
  messages: ThreadMessageRef[],
): Promise<Map<string, string>> {
  const result = await getCachedPlaintextBatch(messages.map((m) => m.id));

  const uncachedFromOthers = messages.filter(
    (m) => !result.has(m.id) && m.sender_id !== currentUserId,
  );
  if (uncachedFromOthers.length === 0) return result;

  const ownDeviceId = await getOwnDeviceId();
  if (!ownDeviceId) return result;

  const { data: envelopeRows, error } = await supabase
    .from('e2ee_message_envelopes')
    .select(
      'message_id, ciphertext, ratchet_public_key, previous_chain_length, message_number, x3dh_sender_identity_key, x3dh_sender_ephemeral_key, x3dh_one_time_prekey_id',
    )
    .in(
      'message_id',
      uncachedFromOthers.map((m) => m.id),
    )
    .eq('recipient_device_id', ownDeviceId);
  if (error) throw error;

  const envelopesByMessageId = new Map(
    (envelopeRows ?? []).map((row) => [row.message_id as string, row]),
  );

  // PostgREST returns `bytea` columns as "\x"+hex over JSON, not base64
  // (confirmed live — see hexToBytes's own header comment) — re-encoded
  // to base64 here so decryptEnvelope's interface stays uniformly
  // base64-in, matching its other caller (encryptForThread's X3DH
  // bootstrap path, which already gets base64 from fetch-prekey-bundles).
  const hexColumnToBase64 = (hex: string) => bytesToBase64(hexToBytes(hex));

  for (const message of uncachedFromOthers) {
    const row = envelopesByMessageId.get(message.id);
    if (!row) continue;

    try {
      const plaintext = await decryptEnvelope(threadId, message.sender_id, {
        ciphertext: hexColumnToBase64(row.ciphertext),
        ratchetPublicKey: hexColumnToBase64(row.ratchet_public_key),
        previousChainLength: row.previous_chain_length,
        messageNumber: row.message_number,
        x3dhSenderIdentityKey: row.x3dh_sender_identity_key
          ? hexColumnToBase64(row.x3dh_sender_identity_key)
          : null,
        x3dhSenderEphemeralKey: row.x3dh_sender_ephemeral_key
          ? hexColumnToBase64(row.x3dh_sender_ephemeral_key)
          : null,
        x3dhOneTimePrekeyId: row.x3dh_one_time_prekey_id,
      });
      await setCachedPlaintext(message.id, plaintext);
      result.set(message.id, plaintext);
    } catch (e) {
      // Decryption failing for one message must not take down the whole
      // thread render — log and leave it out of the result map; the
      // caller's fallback text covers it.
      console.error(`decryptThreadMessages: failed to decrypt message ${message.id}:`, e);
    }
  }

  return result;
}

/** Drops a peer device's ratchet session for one thread — used when a device is revoked/replaced, so the next message to/from it starts a fresh X3DH handshake instead of trying (and failing) to continue a session whose keys no longer correspond to anything real. */
export async function resetSessionWithDevice(threadId: string, deviceId: string): Promise<void> {
  await deleteSession(threadId, deviceId);
}
