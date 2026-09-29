// Real end-to-end encrypted media (session 37/38 follow-up to
// docs/21-E2EE-TECHNICAL-DESIGN.md's own "out of scope for this pass"
// note). Isolated tests for apps/mobile/lib/e2ee/mediaCrypto.ts — pure
// AEAD wrapping, no UI, no server calls, run against the Node/
// libsodium-wrappers-sumo test adapter (sodiumProviderTestAdapter.ts),
// same pattern as e2ee-crypto-core.test.ts.
//
// Run: node supabase/tests/e2ee-media-crypto.test.ts

import { testSodiumProvider as sodium } from '../../apps/mobile/lib/e2ee/sodiumProviderTestAdapter.ts';
import { decryptMediaBytes, encryptMediaBytes } from '../../apps/mobile/lib/e2ee/mediaCrypto.ts';

let pass = 0;
let fail = 0;
function log(label: string, ok: boolean, detail?: string) {
  if (ok) pass++;
  else fail++;
  process.stdout.write(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}\n`);
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}

async function main() {
  await sodium.ready();

  // Round-trip correctness, including a size roughly matching a real
  // resized chat photo (docs/01 §5's 1600px target lands well under 2MB
  // in practice; this doesn't need to be that large to prove the AEAD
  // wrapping is correct, just non-trivially sized).
  const plaintext = randomBytes(50_000);
  const { ciphertext, keyMaterial } = encryptMediaBytes(sodium, plaintext);
  const decrypted = decryptMediaBytes(sodium, ciphertext, keyMaterial);
  log(
    'round-trip: decrypted bytes exactly match the original plaintext',
    Buffer.from(decrypted).equals(Buffer.from(plaintext)),
  );

  // Ciphertext must actually be different from the plaintext (sanity —
  // catches an accidentally-no-op encrypt).
  log(
    'ciphertext is not the plaintext bytes unmodified',
    !Buffer.from(ciphertext.slice(0, plaintext.length)).equals(Buffer.from(plaintext)),
  );

  // Two encryptions of the IDENTICAL plaintext must use different
  // key+nonce pairs and therefore produce different ciphertext — the
  // "never reuse a key+nonce pair" property this module's own header
  // comment calls out as the reason a fresh key is generated per
  // attachment rather than derived from something reusable.
  const second = encryptMediaBytes(sodium, plaintext);
  log(
    'two encryptions of the same plaintext use different keys',
    second.keyMaterial.keyBase64 !== keyMaterial.keyBase64,
  );
  log(
    'two encryptions of the same plaintext use different nonces',
    second.keyMaterial.nonceBase64 !== keyMaterial.nonceBase64,
  );
  log(
    'two encryptions of the same plaintext produce different ciphertext',
    !Buffer.from(second.ciphertext).equals(Buffer.from(ciphertext)),
  );

  // Tamper rejection — AEAD authentication must reject a modified
  // ciphertext outright, never partially decrypt (same guarantee message
  // decryption already has, tested in e2ee-crypto-core.test.ts).
  const tampered = new Uint8Array(ciphertext);
  tampered[0] ^= 0xff;
  let tamperRejected = false;
  try {
    decryptMediaBytes(sodium, tampered, keyMaterial);
  } catch {
    tamperRejected = true;
  }
  log('a tampered ciphertext is rejected, not partially decrypted', tamperRejected);

  // Wrong key must also fail closed.
  const wrongKeyMaterial = encryptMediaBytes(sodium, randomBytes(16)).keyMaterial;
  let wrongKeyRejected = false;
  try {
    decryptMediaBytes(sodium, ciphertext, wrongKeyMaterial);
  } catch {
    wrongKeyRejected = true;
  }
  log('decrypting with the wrong key is rejected', wrongKeyRejected);

  // Empty file (a real, if unusual, edge case — e.g. a 0-byte capture
  // failure caught before upload elsewhere, but the primitive itself
  // shouldn't choke on it) round-trips too.
  const empty = new Uint8Array(0);
  const emptyEncrypted = encryptMediaBytes(sodium, empty);
  const emptyDecrypted = decryptMediaBytes(
    sodium,
    emptyEncrypted.ciphertext,
    emptyEncrypted.keyMaterial,
  );
  log('a zero-length plaintext round-trips correctly', emptyDecrypted.length === 0);

  process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e.message);
  process.exit(1);
});
