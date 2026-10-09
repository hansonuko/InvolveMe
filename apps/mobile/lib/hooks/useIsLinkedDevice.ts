import { base64ToBytes } from '@/lib/e2ee/bytes';
import { useSession } from '@/lib/hooks/useSession';

/**
 * Mirrors `_shared/auth.ts`'s `decodeLinkedDeviceId` exactly, but RN/
 * Hermes-safe: that server-side Deno version uses `atob` directly, which
 * is guaranteed in that runtime but not in this one — same reasoning
 * `lib/e2ee/bytes.ts`'s own header comment gives for why this app's E2EE
 * code never calls `atob`/`Buffer` either. `TextDecoder` (unlike `atob`)
 * is already proven safe on native here — `lib/e2ee/session.ts` decodes
 * real decrypted message plaintext with it today.
 */
function decodeLinkedDeviceId(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(base64ToBytes(base64));
    const payload = JSON.parse(json);
    return typeof payload.linked_device_id === 'string' ? payload.linked_device_id : null;
  } catch {
    return null;
  }
}

/**
 * docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 6 — client-side defense
 * in depth on top of M3's real server-side guard
 * (`requireAuthenticatedUser(req, { blockLinkedDevices: true })`). A
 * linked/companion session's own access token carries a
 * `linked_device_id` claim a real phone session (`signInWithOtp`, GoTrue-
 * issued) never does — decoded straight from the token already in hand,
 * no network round trip, same source of truth the server side reads.
 *
 * This can only ever be `true` on web in practice (pairing mints a
 * session for the *requesting* browser, M2's `get-device-pairing-status`
 * — never for the scanning phone, which keeps its own existing primary
 * session throughout M5's confirm flow), but the check itself is
 * platform-agnostic so it degrades safely rather than silently
 * mis-trusting platform alone.
 */
export function useIsLinkedDevice(): boolean {
  const { session } = useSession();
  // Cheap enough (a string split + a small JSON.parse) to not need
  // memoizing — React Compiler's own automatic memoization covers this
  // either way, a manual `useMemo` here only fought it.
  if (!session?.access_token) return false;
  return decodeLinkedDeviceId(session.access_token) !== null;
}
