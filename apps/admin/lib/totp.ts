import { Secret, TOTP } from 'otpauth';

const ISSUER = 'InvolveMe Admin';

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpEnrollmentUri(email: string, base32Secret: string): string {
  const totp = new TOTP({
    issuer: ISSUER,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32Secret),
  });
  return totp.toString();
}

export function verifyTotpToken(base32Secret: string, token: string): boolean {
  const totp = new TOTP({
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32Secret),
  });
  // window: 1 tolerates the caller's clock being one 30s step off in
  // either direction, standard practice for TOTP verification.
  return totp.validate({ token, window: 1 }) !== null;
}
