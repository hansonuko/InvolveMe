// POST /functions/v1/remove-group-member
//
// Wraps fn_remove_group_member (migration 20260919120000_group_admin_actions.sql)
// — admin-only; the group owner can never be targeted, enforced in the DB
// function itself (not just here) so there's no path to it by calling the
// function directly. p_actor_id is always the authenticated caller's own
// id, same identity-from-JWT posture every Edge Function here uses.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';

const RemoveGroupMemberRequestSchema = z.object({
  group_thread_id: requiredString('group_thread_id'),
  target_user_id: requiredString('target_user_id'),
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

function mapError(pgMessage: string): Response {
  if (pgMessage.startsWith('group_not_found')) {
    return errorResponse(404, 'group_not_found', 'Group not found.');
  }
  if (pgMessage.startsWith('not_a_member')) {
    return errorResponse(403, 'not_a_member', 'You are not a member of this group.');
  }
  if (pgMessage.startsWith('not_admin')) {
    return errorResponse(403, 'not_admin', 'Only a group admin can remove a member.');
  }
  if (pgMessage.startsWith('cannot_remove_owner')) {
    return errorResponse(400, 'cannot_remove_owner', "The group owner can't be removed.");
  }
  if (pgMessage.startsWith('target_not_a_member')) {
    return errorResponse(400, 'target_not_a_member', 'That person is not in this group.');
  }

  console.error('remove-group-member: unmapped DB error:', pgMessage);
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
    console.error('remove-group-member: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(RemoveGroupMemberRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_remove_group_member', {
    p_group_thread_id: payload.group_thread_id,
    p_actor_id: user.id,
    p_target_user_id: payload.target_user_id,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { ok: true });
});
