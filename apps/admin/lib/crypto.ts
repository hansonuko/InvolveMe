// Server-only crypto helpers. All password/secret handling happens here in
// the Next.js layer, never in Postgres (docs/14-ADMIN-DASHBOARD-SCOPING.md
// §8.1 point 2) — the DB stores only opaque hashes/ciphertext.
//
// Password hashing: Node's built-in `crypto.scrypt`, not a native argon2
// package. scrypt is OWASP-accepted for this purpose and is memory-hard
// like argon2id, and using it means zero new native-compiled dependency —
// this project has no argon2/bcrypt anywhere today (its existing PIN-hash
// precedent, two_step_pin_hash, also deliberately uses a built-in-crypto
// approach rather than pulling in a hashing library), and CLAUDE.md rule
// #10 asks to check whether existing tooling already covers a need before
// adding a dependency. This is a deliberate deviation from "argon2id"
// exactly as worded in the docs/14 §8.1 addendum — same security property
// (memory-hard KDF for a low-entropy human-chosen secret), lighter
// dependency footprint.
//
// Recovery codes get a plain SHA-256 (+ no pepper needed): they're
// generated with ~50 bits of their own entropy, not human-chosen, so a
// fast hash is already adequate — matching the reasoning already on record
// for why a slow KDF exists for passwords/PINs but not for high-entropy
// random tokens elsewhere in this codebase.

import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
  createCipheriv,
  createDecipheriv,
} from 'crypto';

// Not `promisify(scrypt)` — TS's overload resolution for the promisified
// form doesn't reliably pick the (password, salt, keylen, options,
// callback) overload over the simpler one, so the options argument gets
// rejected at the type level. A hand-written wrapper sidesteps that
// entirely and is just as correct.
//
// maxmem is explicit and generous (64MB) — Node's default maxmem is 32MB,
// and N=2^15 with the default blockSize (r=8) needs ~128*N*r =32MB on the
// nose, which OpenSSL's scrypt rejects as "exceeding" the default limit at
// that exact boundary (confirmed by hitting this for real while testing
// piece 3 end-to-end, not a hypothetical). Headroom here costs nothing —
// this endpoint is called on login/account-creation, not per-message.
function scryptDerive(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { ...options, maxmem: 64 * 1024 * 1024 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const SCRYPT_KEYLEN = 64;
// N=2^15 costs ~32MB memory and a noticeable-but-not-annoying delay per
// login attempt on typical server hardware — OWASP's current minimum
// recommendation for interactive login is N=2^17, but this is an internal
// admin console authenticating a handful of people, not a mass consumer
// login endpoint, and a lower cost keeps local dev/testing fast. Revisit
// upward if this ever needs to resist a large-scale credential-stuffing
// attempt specifically.
const SCRYPT_N = 2 ** 15;

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptDerive(plaintext, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [, nStr, saltHex, hashHex] = parts as [string, string, string, string];
  const n = Number(nStr);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scryptDerive(plaintext, salt, expected.length, { N: n });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString('hex'));
}

// AES-256-GCM for the TOTP secret at rest — ADMIN_TOTP_ENCRYPTION_KEY is a
// 32-byte key (base64), set once per environment, never committed.
function getTotpEncryptionKey(): Buffer {
  const raw = process.env.ADMIN_TOTP_ENCRYPTION_KEY;
  if (!raw) throw new Error('ADMIN_TOTP_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32)
    throw new Error('ADMIN_TOTP_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return key;
}

export function encryptTotpSecret(secret: string): string {
  const key = getTotpEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${ciphertext.toString('base64')}.${authTag.toString('base64')}`;
}

export function decryptTotpSecret(encrypted: string): string {
  const key = getTotpEncryptionKey();
  const parts = encrypted.split('.');
  if (parts.length !== 3) throw new Error('malformed_totp_ciphertext');
  const [ivB64, ciphertextB64, authTagB64] = parts as [string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
