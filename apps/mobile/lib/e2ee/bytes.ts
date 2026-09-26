// Real end-to-end encryption, step 3 — tiny byte-array helpers shared by
// hmacSha256Rfc2104.ts, x3dh.ts, and doubleRatchet.ts. No crypto logic
// here, just concatenation/comparison primitives too small to be worth a
// dependency.

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Manual base64 encoder — no Buffer, no btoa. Both are Node/browser globals
 * not guaranteed present in the RN/Hermes runtime this module also has to
 * run in, so this uses only bitwise arithmetic over the input bytes.
 * Only used for building map keys (skippedMessageKeys) here, not for any
 * wire format — correctness matters, but there's no external format to
 * stay compatible with.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

const BASE64_LOOKUP: Record<string, number> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < BASE64_CHARS.length; i++) table[BASE64_CHARS[i]] = i;
  return table;
})();

/**
 * Decodes a Postgres `bytea` column as PostgREST actually returns it over
 * JSON: `"\\x" + hex`, NOT base64 — confirmed live against this project's
 * own REST API before writing this (a raw `bytea` select ~~is~~ exactly
 * the "getting this wrong silently corrupts key material" trap
 * 20260926160000_e2ee_schema.sql's own header comment warns about, which
 * is why every server-side function in this feature explicitly re-encodes
 * to base64 before returning — this decoder exists for the one place a
 * mobile client reads e2ee_message_envelopes directly via a plain
 * RLS-gated select instead of through an Edge Function, per that same
 * table's "owner can read their own envelopes" policy).
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('\\x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

/** Inverse of bytesToBase64 — same no-Buffer/no-atob rationale (this app has never had a base64 need before E2EE; Hermes/RN isn't guaranteed to expose either global). */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let outIdx = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_LOOKUP[clean[i]];
    const c1 = BASE64_LOOKUP[clean[i + 1]];
    const c2 = clean[i + 2] !== undefined ? BASE64_LOOKUP[clean[i + 2]] : undefined;
    const c3 = clean[i + 3] !== undefined ? BASE64_LOOKUP[clean[i + 3]] : undefined;

    out[outIdx++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined) out[outIdx++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 !== undefined) out[outIdx++] = ((c2! & 0x03) << 6) | c3;
  }
  return out.slice(0, outIdx);
}
