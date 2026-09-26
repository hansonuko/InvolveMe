// Real end-to-end encryption, step 3 (docs/21-E2EE-TECHNICAL-DESIGN.md §7)
//
// Verifies two hand-rolled crypto building blocks against their
// standards' own published test vectors — external ground truth, not a
// comparison of the two SodiumProvider adapters against each other (see
// hkdfRfc5869.ts and hmacSha256Rfc2104.ts's header comments for why that
// distinction matters):
//
//   1. hmacSha256Rfc2104.ts against RFC 4231 (https://www.rfc-editor.org/
//      rfc/rfc4231, §4.3 Test Case 2 — a key SHORTER than the SHA-256
//      block size, and §4.7 Test Case 6 — a key LONGER than the block
//      size). These two specifically exercise the zero-pad and
//      hash-down-the-key branches that crypto_auth_hmacsha256 itself
//      can't be used for directly (see hmacSha256Rfc2104.ts).
//   2. hkdfRfc5869.ts against RFC 5869 (https://www.rfc-editor.org/rfc/
//      rfc5869, §A.1 and §A.3 — the two SHA-256 cases; §A.2's inputs are
//      valid but too long to usefully hand-transcribe here, and two
//      independent vectors already exercise both the salted and
//      zero-length-salt/info code paths, including a zero-length HMAC
//      key via the salt-as-key Extract step).
//
// Run: node --env-file=.env supabase/tests/e2ee-hkdf-rfc5869.test.ts
// (no DB/network access needed; --env-file is harmless but unnecessary)

import sodium from 'libsodium-wrappers-sumo';
import { hkdfExpand, hkdfExtract } from '../../apps/mobile/lib/e2ee/hkdfRfc5869.ts';
import { hmacSha256 as hmacSha256Rfc2104 } from '../../apps/mobile/lib/e2ee/hmacSha256Rfc2104.ts';

let passed = 0;
let failed = 0;

function log(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok - ${name}`);
  } else {
    failed++;
    console.log(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function sha256(data: Uint8Array): Uint8Array {
  return sodium.crypto_hash_sha256(data);
}

function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmacSha256Rfc2104(sha256, key, message);
}

async function main() {
  await sodium.ready;

  console.log('RFC 4231 Test Case 2 (HMAC-SHA256, key shorter than block size)');
  {
    const key = new TextEncoder().encode('Jefe');
    const data = fromHex('7768617420646f2079612077616e74' + '20666f72206e6f7468696e673f');
    const expected = fromHex(
      '5bdcc146bf60754e6a042426089575c7' + '5a003f089d2739839dec58b964ec3843',
    );
    const actual = hmacSha256(key, data);
    log('HMAC-SHA256 matches RFC 4231 vector', hex(actual) === hex(expected), `got ${hex(actual)}`);
  }

  console.log('RFC 4231 Test Case 6 (HMAC-SHA256, key longer than block size)');
  {
    const key = new Uint8Array(131).fill(0xaa);
    const data = fromHex(
      '54657374205573696e67204c61726765' +
        '72205468616e20426c6f636b2d53697a' +
        '65204b6579202d2048617368204b6579' +
        '204669727374',
    );
    const expected = fromHex(
      '60e431591ee0b67f0d8a26aacbf5b77f' + '8e0bc6213728c5140546040f0ee37f54',
    );
    const actual = hmacSha256(key, data);
    log('HMAC-SHA256 matches RFC 4231 vector', hex(actual) === hex(expected), `got ${hex(actual)}`);
  }

  console.log('RFC 5869 Test Case 1 (basic, SHA-256)');
  {
    const ikm = fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const salt = fromHex('000102030405060708090a0b0c');
    const info = fromHex('f0f1f2f3f4f5f6f7f8f9');
    const expectedPrk = fromHex(
      '077709362c2e32df0ddc3f0dc47bba63' + '90b6c73bb50f9c3122ec844ad7c2b3e5',
    );
    const expectedOkm = fromHex(
      '3cb25f25faacd57a90434f64d0362f2a' +
        '2d2d0a90cf1a5a4c5db02d56ecc4c5bf' +
        '34007208d5b887185865',
    );

    const prk = hkdfExtract(hmacSha256, salt, ikm);
    log('PRK matches RFC vector', hex(prk) === hex(expectedPrk), `got ${hex(prk)}`);

    const okm = hkdfExpand(hmacSha256, prk, info, 42);
    log('OKM (L=42) matches RFC vector', hex(okm) === hex(expectedOkm), `got ${hex(okm)}`);
  }

  console.log('RFC 5869 Test Case 3 (zero-length salt/info, SHA-256)');
  {
    const ikm = fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const salt = new Uint8Array(0);
    const info = new Uint8Array(0);
    const expectedPrk = fromHex(
      '19ef24a32c717b167f33a91d6f648bdf' + '96596776afdb6377ac434c1c293ccb04',
    );
    const expectedOkm = fromHex(
      '8da4e775a563c18f715f802a063c5a31' +
        'b8a11f5c5ee1879ec3454e5f3c738d2d' +
        '9d201395faa4b61a96c8',
    );

    const prk = hkdfExtract(hmacSha256, salt, ikm);
    log('PRK matches RFC vector', hex(prk) === hex(expectedPrk), `got ${hex(prk)}`);

    const okm = hkdfExpand(hmacSha256, prk, info, 42);
    log('OKM (L=42) matches RFC vector', hex(okm) === hex(expectedOkm), `got ${hex(okm)}`);
  }

  console.log('Sanity checks');
  {
    const salt = fromHex('000102030405060708090a0b0c');
    const ikm = fromHex('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
    const prk = hkdfExtract(hmacSha256, salt, ikm);

    const okmA = hkdfExpand(hmacSha256, prk, new TextEncoder().encode('context-a'), 32);
    const okmB = hkdfExpand(hmacSha256, prk, new TextEncoder().encode('context-b'), 32);
    log(
      'different info labels yield different output (domain separation)',
      hex(okmA) !== hex(okmB),
    );

    const okm64 = hkdfExpand(hmacSha256, prk, new TextEncoder().encode('multi-block'), 64);
    log('length > one hash block (64 bytes) succeeds and has correct length', okm64.length === 64);

    let threw = false;
    try {
      hkdfExpand(hmacSha256, prk, new TextEncoder().encode('too-long'), 255 * 32 + 1);
    } catch {
      threw = true;
    }
    log('length beyond 255*HashLen throws', threw);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
