// POST /functions/v1/submit-kyc
//
// New this session — closes the KYC half of the "withdraw needs KYC tier
// ≥ 1" requirement (docs/03-ECONOMY-LEDGER.md §6). Tier 1 only: plain
// BVN/NIN number verification via Prembly's BVN/NIN Basic REST API, no
// camera/liveness capture (see packages/kyc/provider.ts's header comment
// for why the camera-based Tier 2 widget is deliberately out of scope this
// pass).
//
// No financial logic here (CLAUDE.md rule #1's spirit extended to identity
// data, same as every other Edge Function): this function authenticates,
// calls KycProvider.verifyIdentity(), hashes the BVN/NIN with a
// server-only pepper before it ever touches a row (raw numbers are never
// persisted, per docs/07-COMPLIANCE-LEGAL.md §5), and writes kyc_records +
// users.kyc_tier. The client never sees the verified name/DOB back — only
// whether it succeeded.
//
// Every call to Prembly costs real money (~₦45/attempt, confirmed live —
// see prembly.ts's header comment) regardless of outcome, which is why
// this doesn't retry internally on a "not found" result; that's a real
// user decision (re-check their number and resubmit), not something to
// paper over with an automatic retry that doubles the cost.
//
// Watchlist handling: Prembly's BVN Basic response already includes
// watchlist screening (confirmed live, not assumed — see prembly.ts).
// docs/07-COMPLIANCE-LEGAL.md §2 requires a match be "blocked or flagged,
// never silently allowed" — a watchlisted match here is blocked (no tier
// bump) and logged to fraud_signals for review, not surfaced to the user
// as a generic failure that looks the same as "number not found".

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { loadKycHashPepper, loadPremblyConfig } from '../_shared/kyc-config.ts';
import { parseBody } from '../_shared/validate.ts';
import { createPremblyProvider } from '../../../packages/kyc/prembly.ts';

const TYPE_MSG = 'type must be "bvn" or "nin".';
const NUMBER_MSG = 'number must be exactly 11 digits.';
const SubmitKycRequestSchema = z.object({
  type: z.enum(['bvn', 'nin'], { errorMap: () => ({ message: TYPE_MSG }) }),
  number: z
    .string({ required_error: NUMBER_MSG, invalid_type_error: NUMBER_MSG })
    .regex(/^\d{11}$/, NUMBER_MSG),
});

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

async function hashWithPepper(value: string, pepper: string): Promise<string> {
  const data = new TextEncoder().encode(`${value}:${pepper}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('submit-kyc: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  // Both BVN and NIN are 11 digits in Nigeria — a cheap sanity check before
  // spending real money on a call that's guaranteed to fail.
  const parsed = parseBody(SubmitKycRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const pepper = loadKycHashPepper();
  if (!pepper) {
    console.error('submit-kyc: KYC_HASH_PEPPER is not configured.');
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  const provider = createPremblyProvider(loadPremblyConfig());
  const db = serviceRoleClient();

  let result;
  try {
    result = await provider.verifyIdentity({ type: payload.type, number: payload.number });
  } catch (e) {
    console.error('submit-kyc: provider.verifyIdentity failed:', e);
    return errorResponse(
      503,
      'kyc_provider_unavailable',
      'Could not verify right now — please try again shortly.',
    );
  }

  const numberHash = await hashWithPepper(payload.number, pepper);

  if (result.watchlisted) {
    await db.from('kyc_records').insert({
      user_id: user.id,
      tier: 1,
      provider: 'prembly',
      provider_ref: result.providerRef,
      bvn_or_nin_hash: numberHash,
      status: 'failed',
    });
    await db.from('fraud_signals').insert({
      user_id: user.id,
      signal_type: 'kyc_watchlist_match',
      severity: 'high',
      metadata: { provider: 'prembly', provider_ref: result.providerRef },
    });
    // Deliberately the same generic response as a not-found/failed
    // verification — a watchlist hit is not something to reveal to the
    // person triggering it, per standard sanctions-screening practice.
    return errorResponse(422, 'verification_failed', "We couldn't verify that number.");
  }

  if (!result.verified) {
    await db.from('kyc_records').insert({
      user_id: user.id,
      tier: 1,
      provider: 'prembly',
      provider_ref: result.providerRef,
      bvn_or_nin_hash: numberHash,
      status: 'failed',
    });
    return errorResponse(422, 'verification_failed', "We couldn't verify that number.");
  }

  await db.from('kyc_records').insert({
    user_id: user.id,
    tier: 1,
    provider: 'prembly',
    provider_ref: result.providerRef,
    bvn_or_nin_hash: numberHash,
    status: 'verified',
    verified_at: new Date().toISOString(),
    // Used later by link-bank-account to name-match against the bank's
    // registered account name — see that migration's header comment for
    // why this needs to live here rather than being re-derived from the
    // (deliberately one-way) bvn_or_nin_hash.
    verified_first_name: result.identity?.firstName ?? null,
    verified_middle_name: result.identity?.middleName ?? null,
    verified_last_name: result.identity?.lastName ?? null,
  });

  // Never downgrades an existing higher tier (nothing sets tier 2 yet, but
  // this stays correct if that's ever added).
  const { data: userRow } = await db.from('users').select('kyc_tier').eq('id', user.id).single();
  if (!userRow || (userRow.kyc_tier ?? 0) < 1) {
    await db.from('users').update({ kyc_tier: 1 }).eq('id', user.id);
  }

  return json(200, { verified: true, tier: 1 });
});
