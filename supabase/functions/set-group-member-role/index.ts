// POST /functions/v1/set-group-member-role
//
// Wraps fn_set_group_member_role (migration 20260919120000_group_admin_actions.sql)
// — promote/demote, admin-only. The owner's own role can never be changed
// (enforced in the DB function). p_actor_id is always the authenticated
// caller's own id.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface SetGroupMemberRoleRequestBody {
  group_thread_id?: string;
  target_user_id?: string;
  role?: string;
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
  if (pgMessage.startsWith('not_admin')) {
    return errorResponse(403, 'not_admin', 'Only a group admin can change roles.');
  }
  if (pgMessage.startsWith('cannot_change_owner_role')) {
    return errorResponse(
      400,
      'cannot_change_owner_role',
      "The group owner's role can't be changed.",
    );
  }
  if (pgMessage.startsWith('target_not_a_member')) {
    return errorResponse(400, 'target_not_a_member', 'That person is not in this group.');
  }
  if (pgMessage.startsWith('invalid_role')) {
    return errorResponse(400, 'invalid_role', 'role must be "admin" or "member".');
  }

  console.error('set-group-member-role: unmapped DB error:', pgMessage);
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
    console.error('set-group-member-role: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: SetGroupMemberRoleRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (
    typeof payload.group_thread_id !== 'string' ||
    typeof payload.target_user_id !== 'string' ||
    (payload.role !== 'admin' && payload.role !== 'member')
  ) {
    return errorResponse(
      400,
      'invalid_request',
      'group_thread_id, target_user_id, and role ("admin" | "member") are required.',
    );
  }

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_set_group_member_role', {
    p_group_thread_id: payload.group_thread_id,
    p_actor_id: user.id,
    p_target_user_id: payload.target_user_id,
    p_role: payload.role,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { ok: true });
});
