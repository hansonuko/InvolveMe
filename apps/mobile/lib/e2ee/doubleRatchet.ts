// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §1)
//
// Double Ratchet, implemented from the public spec
// (https://signal.org/docs/specifications/doubleratchet/), not from any
// Signal source code. Pure functions — every operation takes a state and
// returns a new state, never mutates its input — so a caller only
// persists the new state after a decrypt actually succeeds, matching the
// spec's explicit requirement: "If an exception is raised... the message
// is discarded and changes to the state object are discarded." No header
// encryption (spec §4) — out of scope here; matches docs/21 §2's schema,
// which stores ratchet_public_key/previous_chain_length/message_number
// as plain columns, not ciphertext.
//
// KDF_RK and KDF_CK are both built on SodiumProvider's hkdfExtract/
// hkdfExpand rather than a separate raw-HMAC primitive:
//   - KDF_RK(rk, dh_out): spec-recommended construction exactly — HKDF
//     with salt=rk, ikm=dh_out, info=a distinct label, 64-byte output
//     split into (new root key, new chain key).
//   - KDF_CK(ck): the spec's example recommendation is "HMAC keyed by ck,
//     with separate constants 0x01/0x02 as input" for (message key, next
//     chain key) — a *recommendation*, not a byte-exact mandate (compare
//     KDF_RK's own "recommended to be implemented using HKDF" phrasing).
//     A single HKDF-Expand call with prk=ck reduces to exactly one HMAC
//     call — HMAC(ck, info | 0x01) — since Expand's first block is
//     HMAC(prk, T(0)="" | info | counter). Using ck directly as an
//     Expand-stage key is legitimate: ck is always a fixed 32-byte
//     high-entropy value (never attacker-influenced/variable-length
//     input), exactly HKDF's own PRK precondition, so the Extract stage
//     (which exists to handle variable/weak input keying material) isn't
//     needed here. This reuses only the two provider primitives already
//     verified against RFC 5869 (hkdfRfc5869.test.ts), rather than adding
//     a third primitive whose production (native) and test (hand-rolled)
//     implementations would need independent verification of their own.
//
// ENCRYPT(mk, plaintext, ad): the spec's own example recommendation
// targets AES-CBC+HMAC specifically because it predates wide availability
// of a good AEAD; docs/21 §1 already committed to XChaCha20-Poly1305
// (a full AEAD) instead, which the spec explicitly allows ("This function
// is recommended to be implemented with an AEAD encryption scheme..." —
// XChaCha20-Poly1305 qualifies directly, no CBC+HMAC composition needed).
// The message key mk is used once per message and then discarded by
// construction (fresh chain-key advance every message), so deriving a
// deterministic (key, nonce) pair from mk via HKDF is safe — no nonce
// reuse can occur under a single mk.

import { bytesToBase64, concatBytes, constantTimeEqual } from './bytes.ts';
import type { KeyPair, SodiumProvider } from './sodiumProvider.ts';

const HASH_LEN = 32;
const KDF_RK_INFO = 'InvolveMe-DR-KDF-RK-v1';
const KDF_CK_MESSAGE_KEY_INFO = 'InvolveMe-DR-KDF-CK-message-key-v1';
const KDF_CK_CHAIN_KEY_INFO = 'InvolveMe-DR-KDF-CK-chain-key-v1';
const ENCRYPT_INFO = 'InvolveMe-DR-message-encrypt-v1';
const AEAD_KEY_LEN = 32;
const AEAD_NONCE_LEN = 24; // XChaCha20-Poly1305

/** Maximum message keys a single receiving chain will cache for late/out-of-order delivery. Bounds attacker-triggerable compute; generous enough for realistic reordering/loss. */
export const MAX_SKIP = 1000;

export class SkippedTooManyMessagesError extends Error {
  constructor() {
    super('Too many skipped messages in this chain (possible attack or badly broken delivery).');
    this.name = 'SkippedTooManyMessagesError';
  }
}

export interface RatchetHeader {
  ratchetPublicKey: Uint8Array;
  previousChainLength: number;
  messageNumber: number;
}

export interface RatchetState {
  dhSelfPublicKey: Uint8Array;
  dhSelfPrivateKey: Uint8Array;
  dhRemotePublicKey: Uint8Array | null;
  rootKey: Uint8Array;
  chainKeySend: Uint8Array | null;
  chainKeyRecv: Uint8Array | null;
  sendMessageNumber: number;
  recvMessageNumber: number;
  previousSendChainLength: number;
  /** key: `${base64(remote ratchet public key at the time)}:${message number}` */
  skippedMessageKeys: ReadonlyMap<string, Uint8Array>;
}

function skippedKey(ratchetPublicKey: Uint8Array, messageNumber: number): string {
  return `${bytesToBase64(ratchetPublicKey)}:${messageNumber}`;
}

function kdfRootKey(
  sodium: SodiumProvider,
  rootKey: Uint8Array,
  dhOut: Uint8Array,
): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const prk = sodium.hkdfExtract(rootKey, dhOut);
  const okm = sodium.hkdfExpand(prk, KDF_RK_INFO, HASH_LEN * 2);
  return { rootKey: okm.slice(0, HASH_LEN), chainKey: okm.slice(HASH_LEN) };
}

function kdfChainKey(
  sodium: SodiumProvider,
  chainKey: Uint8Array,
): { chainKey: Uint8Array; messageKey: Uint8Array } {
  const messageKey = sodium.hkdfExpand(chainKey, KDF_CK_MESSAGE_KEY_INFO, HASH_LEN);
  const nextChainKey = sodium.hkdfExpand(chainKey, KDF_CK_CHAIN_KEY_INFO, HASH_LEN);
  return { chainKey: nextChainKey, messageKey };
}

function deriveAeadKeyAndNonce(
  sodium: SodiumProvider,
  messageKey: Uint8Array,
): { key: Uint8Array; nonce: Uint8Array } {
  const salt = new Uint8Array(HASH_LEN);
  const prk = sodium.hkdfExtract(salt, messageKey);
  const okm = sodium.hkdfExpand(prk, ENCRYPT_INFO, AEAD_KEY_LEN + AEAD_NONCE_LEN);
  return { key: okm.slice(0, AEAD_KEY_LEN), nonce: okm.slice(AEAD_KEY_LEN) };
}

function encodeHeader(header: RatchetHeader): Uint8Array {
  const out = new Uint8Array(header.ratchetPublicKey.length + 8);
  out.set(header.ratchetPublicKey, 0);
  new DataView(out.buffer).setUint32(
    header.ratchetPublicKey.length,
    header.previousChainLength,
    false,
  );
  new DataView(out.buffer).setUint32(
    header.ratchetPublicKey.length + 4,
    header.messageNumber,
    false,
  );
  return out;
}

function associatedDataWithHeader(associatedData: Uint8Array, header: RatchetHeader): Uint8Array {
  return concatBytes(associatedData, encodeHeader(header));
}

/** Alice's side: she initiated X3DH and already knows Bob's current ratchet (=signed prekey) public key. */
export function initRatchetAsAlice(
  sodium: SodiumProvider,
  sharedSecret: Uint8Array,
  bobRatchetPublicKey: Uint8Array,
): RatchetState {
  const dhSelf = sodium.generateX25519KeyPair();
  const dhOut = sodium.scalarMult(dhSelf.privateKey, bobRatchetPublicKey);
  const { rootKey, chainKey } = kdfRootKey(sodium, sharedSecret, dhOut);

  return {
    dhSelfPublicKey: dhSelf.publicKey,
    dhSelfPrivateKey: dhSelf.privateKey,
    dhRemotePublicKey: bobRatchetPublicKey,
    rootKey,
    chainKeySend: chainKey,
    chainKeyRecv: null,
    sendMessageNumber: 0,
    recvMessageNumber: 0,
    previousSendChainLength: 0,
    skippedMessageKeys: new Map(),
  };
}

/** Bob's side: his signed prekey keypair doubles as his initial ratchet keypair. */
export function initRatchetAsBob(
  sodium: SodiumProvider,
  sharedSecret: Uint8Array,
  bobRatchetKeyPair: KeyPair,
): RatchetState {
  return {
    dhSelfPublicKey: bobRatchetKeyPair.publicKey,
    dhSelfPrivateKey: bobRatchetKeyPair.privateKey,
    dhRemotePublicKey: null,
    rootKey: sharedSecret,
    chainKeySend: null,
    chainKeyRecv: null,
    sendMessageNumber: 0,
    recvMessageNumber: 0,
    previousSendChainLength: 0,
    skippedMessageKeys: new Map(),
  };
}

export interface EncryptResult {
  nextState: RatchetState;
  header: RatchetHeader;
  ciphertext: Uint8Array;
}

export function ratchetEncrypt(
  sodium: SodiumProvider,
  state: RatchetState,
  plaintext: Uint8Array,
  associatedData: Uint8Array,
): EncryptResult {
  if (!state.chainKeySend) {
    throw new Error(
      'ratchetEncrypt: no sending chain key yet (Bob must receive before he can send).',
    );
  }

  const { chainKey: nextChainKeySend, messageKey } = kdfChainKey(sodium, state.chainKeySend);
  const header: RatchetHeader = {
    ratchetPublicKey: state.dhSelfPublicKey,
    previousChainLength: state.previousSendChainLength,
    messageNumber: state.sendMessageNumber,
  };

  const { key, nonce } = deriveAeadKeyAndNonce(sodium, messageKey);
  const ciphertext = sodium.aeadEncrypt(
    plaintext,
    associatedDataWithHeader(associatedData, header),
    nonce,
    key,
  );

  return {
    nextState: {
      ...state,
      chainKeySend: nextChainKeySend,
      sendMessageNumber: state.sendMessageNumber + 1,
    },
    header,
    ciphertext,
  };
}

function skipMessageKeys(
  sodium: SodiumProvider,
  state: RatchetState,
  until: number,
): {
  chainKeyRecv: Uint8Array | null;
  recvMessageNumber: number;
  skipped: Map<string, Uint8Array>;
} {
  const skipped = new Map(state.skippedMessageKeys);
  let chainKeyRecv = state.chainKeyRecv;
  let recvMessageNumber = state.recvMessageNumber;

  if (recvMessageNumber + MAX_SKIP < until) {
    throw new SkippedTooManyMessagesError();
  }

  if (chainKeyRecv && state.dhRemotePublicKey) {
    while (recvMessageNumber < until) {
      const { chainKey, messageKey } = kdfChainKey(sodium, chainKeyRecv);
      skipped.set(skippedKey(state.dhRemotePublicKey, recvMessageNumber), messageKey);
      chainKeyRecv = chainKey;
      recvMessageNumber += 1;
    }
  }

  return { chainKeyRecv, recvMessageNumber, skipped };
}

function dhRatchetStep(
  sodium: SodiumProvider,
  state: RatchetState,
  header: RatchetHeader,
): RatchetState {
  const dhOutRecv = sodium.scalarMult(state.dhSelfPrivateKey, header.ratchetPublicKey);
  const { rootKey: rootKeyAfterRecv, chainKey: chainKeyRecv } = kdfRootKey(
    sodium,
    state.rootKey,
    dhOutRecv,
  );

  const newDhSelf = sodium.generateX25519KeyPair();
  const dhOutSend = sodium.scalarMult(newDhSelf.privateKey, header.ratchetPublicKey);
  const { rootKey: rootKeyAfterSend, chainKey: chainKeySend } = kdfRootKey(
    sodium,
    rootKeyAfterRecv,
    dhOutSend,
  );

  return {
    ...state,
    dhSelfPublicKey: newDhSelf.publicKey,
    dhSelfPrivateKey: newDhSelf.privateKey,
    dhRemotePublicKey: header.ratchetPublicKey,
    rootKey: rootKeyAfterSend,
    chainKeySend,
    chainKeyRecv,
    previousSendChainLength: state.sendMessageNumber,
    sendMessageNumber: 0,
    recvMessageNumber: 0,
  };
}

export interface DecryptResult {
  nextState: RatchetState;
  plaintext: Uint8Array;
}

export function ratchetDecrypt(
  sodium: SodiumProvider,
  state: RatchetState,
  header: RatchetHeader,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
): DecryptResult {
  const skippedLookupKey = skippedKey(header.ratchetPublicKey, header.messageNumber);
  const cachedMessageKey = state.skippedMessageKeys.get(skippedLookupKey);

  if (cachedMessageKey) {
    const plaintext = decryptWithMessageKey(
      sodium,
      cachedMessageKey,
      ciphertext,
      associatedData,
      header,
    );
    const remainingSkipped = new Map(state.skippedMessageKeys);
    remainingSkipped.delete(skippedLookupKey);
    return { nextState: { ...state, skippedMessageKeys: remainingSkipped }, plaintext };
  }

  let workingState = state;

  const isNewRatchetKey =
    !state.dhRemotePublicKey ||
    !constantTimeEqual(state.dhRemotePublicKey, header.ratchetPublicKey);
  if (isNewRatchetKey) {
    const skipResult = skipMessageKeys(sodium, workingState, header.previousChainLength);
    workingState = {
      ...workingState,
      chainKeyRecv: skipResult.chainKeyRecv,
      recvMessageNumber: skipResult.recvMessageNumber,
      skippedMessageKeys: skipResult.skipped,
    };
    workingState = dhRatchetStep(sodium, workingState, header);
  }

  const skipResult = skipMessageKeys(sodium, workingState, header.messageNumber);
  workingState = {
    ...workingState,
    chainKeyRecv: skipResult.chainKeyRecv,
    recvMessageNumber: skipResult.recvMessageNumber,
    skippedMessageKeys: skipResult.skipped,
  };

  if (!workingState.chainKeyRecv) {
    throw new Error(
      'ratchetDecrypt: no receiving chain key after DH ratchet step (should not happen).',
    );
  }
  const { chainKey: nextChainKeyRecv, messageKey } = kdfChainKey(sodium, workingState.chainKeyRecv);

  const plaintext = decryptWithMessageKey(sodium, messageKey, ciphertext, associatedData, header);

  return {
    nextState: {
      ...workingState,
      chainKeyRecv: nextChainKeyRecv,
      recvMessageNumber: workingState.recvMessageNumber + 1,
    },
    plaintext,
  };
}

function decryptWithMessageKey(
  sodium: SodiumProvider,
  messageKey: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array,
  header: RatchetHeader,
): Uint8Array {
  const { key, nonce } = deriveAeadKeyAndNonce(sodium, messageKey);
  return sodium.aeadDecrypt(
    ciphertext,
    associatedDataWithHeader(associatedData, header),
    nonce,
    key,
  );
}
