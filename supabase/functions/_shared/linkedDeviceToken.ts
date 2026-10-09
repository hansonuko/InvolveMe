// _shared/linkedDeviceToken.ts — mints a linked (companion) device's
// session token. docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 0 (live-
// verified against this project's real dev DB, 2026-10-09, see
// docs/02-DATA-MODEL.md's linked_devices entry for the full finding):
// there is no Supabase Auth Admin API path for minting a session on a
// phone-only-auth project — admin.generateLink is entirely email-based.
// The real mechanism, with precedent already in this repo's own test
// suite (supabase/tests/*.test.js already manually HS256-signs JWTs with
// SUPABASE_JWT_SECRET to call Edge Functions as an arbitrary user):
// confirmed live that a real @supabase/supabase-js client's setSession()
// accepts a token signed this way with no error, and that auth.uid()
// resolves correctly server-side afterward — not a client-side illusion.
//
// No auth.sessions/auth.refresh_tokens row is ever written — this is a
// bare, stateless, self-verifying token, which is also exactly why it
// carries no real refresh capability (see linked_device_session_ttl_
// seconds's own pricing_config comment) and why revocation can't use
// `admin.signOut` — there's no session row for that to act on. Instead,
// `linked_device_id` is embedded directly in the payload — this app's own
// claim, not a Supabase Auth concept — so a reduced-privilege Edge
// Function guard (Milestone 3) can check it against a live, unrevoked
// `linked_devices` row. A real phone session (signInWithOtp, GoTrue-
// issued) never carries this claim at all.
//
// Deno's native Web Crypto API (crypto.subtle), not an npm JWT library —
// this is a small, self-contained HS256 sign, and avoids a new dependency
// for something this codebase's own "stay lite" rule would rather not add
// (CLAUDE.md rule #10).
//
// Reads LINKED_DEVICE_JWT_SECRET, not SUPABASE_JWT_SECRET — found live,
// 2026-10-09, while verifying M4 end-to-end: `supabase secrets set` hard-
// rejects any name starting with `SUPABASE_` ("Env name cannot start with
// SUPABASE_, skipping") since that prefix is reserved for the platform's
// own auto-injected vars (SUPABASE_URL/SUPABASE_ANON_KEY/SUPABASE_SERVICE_
// ROLE_KEY and friends) — it is never silently populated with a project's
// legacy JWT secret the way those are. This meant the function had been
// throwing on every real call since M2 shipped (confirmed via a raw,
// unmocked HTTP call against the live deployed function: a 500 on every
// single 'confirmed' poll, no exceptions) — M2's own tests never caught
// it because they spawn the function locally with env vars supplied by
// the test harness's own shell, not the real deployed runtime's secret
// store, so SUPABASE_JWT_SECRET being set locally (for signing test
// tokens) always hid the gap. Same *value* as the project's real JWT
// secret (this still has to match what GoTrue verifies against) — only
// the Edge Function secret's *name* changed, specifically to dodge the
// reserved prefix.
const JWT_SECRET_ENV_VAR = 'LINKED_DEVICE_JWT_SECRET';

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signLinkedDeviceToken(
  userId: string,
  linkedDeviceId: string,
  ttlSeconds: number,
): Promise<string> {
  const secret = Deno.env.get(JWT_SECRET_ENV_VAR);
  if (!secret) {
    throw new Error(`${JWT_SECRET_ENV_VAR} is not set.`);
  }

  const encoder = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    aud: 'authenticated',
    role: 'authenticated',
    sub: userId,
    linked_device_id: linkedDeviceId,
    iat: now,
    exp: now + ttlSeconds,
  };

  const signingInput = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));

  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
