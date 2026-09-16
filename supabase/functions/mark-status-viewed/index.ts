// POST /functions/v1/mark-status-viewed
//
// Records that the caller has seen a status update (see migration
// 20260916090000_status_visibility_and_view_tracking.sql). No financial
// logic — this follows the same "identity is re-derived from the caller's
// JWT, never trusted from the request body" posture every other function
// here uses, via _shared/auth.ts, same shape as mark-thread-read.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface MarkStatusViewedRequestBody {
  status_id?: string;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return json(status, { error: code, message });
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
    console.error('mark-status-viewed: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: MarkStatusViewedRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.status_id !== 'string' || payload.status_id.trim().length === 0) {
    return errorResponse(400, 'invalid_request', 'status_id is required.');
  }

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_mark_status_viewed', {
    p_status_id: payload.status_id,
    p_viewer_id: user.id,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('status_not_found')) {
      return errorResponse(404, 'status_not_found', 'No such status update.');
    }
    if (message.includes('not_visible')) {
      return errorResponse(403, 'not_visible', "You can't view this status update.");
    }
    console.error('mark-status-viewed: fn_mark_status_viewed failed:', message);
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }

  return json(200, { ok: true });
});
