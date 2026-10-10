// POST /functions/v1/list-linked-devices
//
// docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 2. Backs the mobile
// "Linked Devices" settings screen (Milestone 5) — wraps
// fn_list_linked_devices. Phone-only, authenticated, no body needed
// (always the caller's own devices, never a request-supplied user id).

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { corsHeaders, handlePreflight } from '../_shared/cors.ts';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('list-linked-devices: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  const db = serviceRoleClient();
  const { data, error } = await db.rpc('fn_list_linked_devices', { p_user_id: user.id });

  if (error) {
    console.error('list-linked-devices: fn_list_linked_devices failed:', error.message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { devices: data ?? [] });
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  const res = await handleRequest(req);
  const extra = corsHeaders(req);
  if (Object.keys(extra).length === 0) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
});
