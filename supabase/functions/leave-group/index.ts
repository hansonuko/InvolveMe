// POST /functions/v1/leave-group
//
// Wraps fn_leave_group (migration 20260919120000_group_admin_actions.sql) —
// self-service only, p_actor_id is always the authenticated caller's own
// id. The group owner is blocked from leaving (enforced in the DB function
// itself): there's no ownership-transfer path yet to hand the fixed-earner
// role (group_threads.created_by) to someone else first, per
// 20260913200000_group_chats.sql's own header comment.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface LeaveGroupRequestBody {
  group_thread_id?: string;
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

function mapError(pgMessage: string): Response {
  if (pgMessage.startsWith('group_not_found')) {
    return errorResponse(404, 'group_not_found', 'Group not found.');
  }
  if (pgMessage.startsWith('not_a_member')) {
    return errorResponse(403, 'not_a_member', 'You are not a member of this group.');
  }
  if (pgMessage.startsWith('owner_cannot_leave')) {
    return errorResponse(
      400,
      'owner_cannot_leave',
      "As the group owner, you can't leave yet — ownership transfer isn't built.",
    );
  }

  console.error('leave-group: unmapped DB error:', pgMessage);
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
    console.error('leave-group: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: LeaveGroupRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.group_thread_id !== 'string') {
    return errorResponse(400, 'invalid_request', 'group_thread_id is required.');
  }

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_leave_group', {
    p_group_thread_id: payload.group_thread_id,
    p_actor_id: user.id,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { ok: true });
});
