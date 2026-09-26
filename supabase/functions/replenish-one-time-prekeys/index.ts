// POST /functions/v1/replenish-one-time-prekeys
//
// Real end-to-end encryption, step 2 (docs/21-E2EE-TECHNICAL-DESIGN.md §3)
// — wraps fn_replenish_one_time_prekeys. A device tops up its own
// one-time-prekey pool once running low (the client checks its own
// remaining count and calls this proactively — no server-side "you're
// running low" push exists or is needed, since the client already knows
// how many prekeys it originally generated versus how many it's used).
// Self-only: fn_replenish_one_time_prekeys itself rejects a caller trying
// to top up a device they don't own, but this function also can't be
// fooled by a client-supplied caller id — p_caller_id is always the
// authenticated caller's own id (_shared/auth.ts).

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredBase64Key, requiredUuid } from '../_shared/validate.ts';

const ONE_TIME_PREKEY_MSG = 'one_time_prekeys must be a non-empty array of {key_id, public_key}.';

const ReplenishOneTimePrekeysRequestSchema = z.object({
  device_id: requiredUuid('device_id'),
  one_time_prekeys: z
    .array(
      z.object({
        key_id: z.number(),
        public_key: requiredBase64Key('one_time_prekeys[].public_key', 32),
      }),
      { required_error: ONE_TIME_PREKEY_MSG, invalid_type_error: ONE_TIME_PREKEY_MSG },
    )
    .min(1, ONE_TIME_PREKEY_MSG),
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

function mapReplenishError(pgMessage: string): Response {
  if (pgMessage.startsWith('device_not_found')) {
    return errorResponse(404, 'device_not_found', 'No such device.');
  }
  if (pgMessage.startsWith('not_your_device')) {
    return errorResponse(403, 'not_your_device', "That device isn't yours.");
  }
  console.error('replenish-one-time-prekeys: unmapped DB error:', pgMessage);
  return errorResponse(500, 'internal_error', 'Something went wrong.');
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
    console.error('replenish-one-time-prekeys: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(ReplenishOneTimePrekeysRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { data: insertedCount, error } = await db.rpc('fn_replenish_one_time_prekeys', {
    p_caller_id: user.id,
    p_device_id: payload.device_id,
    p_new_prekeys: payload.one_time_prekeys,
  });

  if (error) {
    return mapReplenishError(error.message);
  }

  return json(200, { inserted_count: insertedCount });
});
