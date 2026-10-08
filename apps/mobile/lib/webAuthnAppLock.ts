/**
 * Web's real equivalent of `lib/appLock.ts`'s native biometric gate —
 * docs/22-FULL-PWA-SCOPING.md Phase B item 1. `expo-local-authentication`
 * has no web implementation of its own (its `.web.ts` stub unconditionally
 * reports no enrolled lock, confirmed live), so this delegates to the
 * actual browser-native equivalent instead: WebAuthn's platform
 * authenticator, which is exactly "whatever lock the device already has"
 * (Windows Hello, Touch ID/Face ID in Safari, Android's fingerprint/face
 * unlock) — not a custom PIN, which would be a weaker, new thing to secure
 * instead of delegating to what the OS already provides, same reasoning
 * appLock.ts's own header comment gives for why native doesn't use a
 * custom PIN either.
 *
 * Purely client-side, same contract as the native gate: the credential is
 * never sent to or verified by any server — a successful assertion is
 * trusted locally, exactly as `authenticateAsync`'s `result.success` is on
 * native. This is a hardening layer on top of the OTP-backed session, not
 * a second authentication factor the server knows about, so there's
 * nothing to register server-side and no new attack surface against the
 * account itself — only against this one local "is the gate open" flag.
 */

const CREDENTIAL_ID_KEY = 'involveme-applock-credential-id';

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  new Uint8Array(buffer).forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export async function isWebAuthnLockAvailable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** A cancelled/declined OS prompt surfaces as `NotAllowedError` — mapped
 * to "stay locked, let the user retry," the same meaning
 * `result.success === false` has on native. Any other error (no
 * authenticator, a browser bug, a corrupted stored credential) is left to
 * the caller's own catch-all, which fails open — see useAppLock's own
 * header comment for why an unexpected error here must never permanently
 * lock someone out of their own already-valid session. */
class DeclinedError extends Error {}

async function registerCredential(): Promise<boolean> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(16));
  try {
    const credential = (await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'InvolveMe' },
        user: { id: userId, name: 'app-lock', displayName: 'InvolveMe app lock' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
        },
        timeout: 60000,
      },
    })) as PublicKeyCredential | null;
    if (!credential) return false;
    window.localStorage.setItem(CREDENTIAL_ID_KEY, toBase64Url(credential.rawId));
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') throw new DeclinedError();
    throw e;
  }
}

async function assertCredential(credentialId: string): Promise<boolean> {
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ id: fromBase64Url(credentialId), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!assertion;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'NotAllowedError') throw new DeclinedError();
    throw e;
  }
}

/** Returns `true` once the OS's own platform authenticator has verified
 * the person at the device — registering a fresh local credential the
 * first time this runs (itself a user-verification ceremony, so it
 * doubles as that first unlock), and just re-asserting against the stored
 * one on every call after. Throws only for a declined/cancelled prompt
 * (caller maps that to "stay locked, retry") — any other failure
 * propagates for the caller's own fail-open handling. */
export async function attemptWebAuthnUnlock(): Promise<boolean> {
  const existingId = window.localStorage.getItem(CREDENTIAL_ID_KEY);
  try {
    if (!existingId) return await registerCredential();
    return await assertCredential(existingId);
  } catch (e) {
    if (e instanceof DeclinedError) return false;
    throw e;
  }
}
