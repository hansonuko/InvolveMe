// Real end-to-end encryption, step 6 (docs/21-E2EE-TECHNICAL-DESIGN.md §7)
//
// Per-device async mutex. Exists because session.ts's encryptForThread/
// decryptEnvelope each do a load-ratchet-save sequence against
// sessionStore.ts with nothing serializing overlapping calls for the same
// device — the adversarial review this migration's own header comment
// references found this live: two concurrent encrypts for the same
// recipient device both read the same base ratchet state and both landed
// on chain position 0, producing two different real plaintexts encrypted
// under the IDENTICAL XChaCha20-Poly1305 key and nonce (a working
// reproduction, not a theoretical concern — an observer holding both
// ciphertexts, which the server always does, can XOR them to recover
// plaintextA XOR plaintextB directly). The same missing lock also let a
// losing concurrent decrypt overwrite a winning one's persisted state,
// resurrecting an already-used-and-discarded message key on disk — a
// forward-secrecy violation.
//
// A plain per-key promise chain is sufficient: this is about ordering two
// async call sites in the same JS event loop, not real multi-threading.

const queues = new Map<string, Promise<unknown>>();

export function withDeviceLock<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = (queues.get(deviceId) as Promise<unknown> | undefined) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Stored for the next caller to queue behind — resolves once `run`
  // settles either way, so a thrown error never leaves the lock stuck.
  queues.set(
    deviceId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
