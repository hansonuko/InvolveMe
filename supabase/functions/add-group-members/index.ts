// POST /functions/v1/add-group-members
//
// Wraps fn_add_group_members (migration 20260919120000_group_admin_actions.sql)
// — any current member can add more, per that migration's header comment on
// matching WhatsApp's default permission model. p_actor_id is always the
// authenticated caller's own id, never taken from the request body (CLAUDE.md
// rule #1's identity-from-JWT posture, same as create-group-thread).

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';

const MEMBER_IDS_MSG = 'member_ids must be a non-empty array of user ids.';
const AddGroupMembersRequestSchema = z.object({
  group_thread_id: requiredString('group_thread_id'),
  member_ids: z
    .array(z.string({ invalid_type_error: MEMBER_IDS_MSG }), {
      required_error: MEMBER_IDS_MSG,
      invalid_type_error: MEMBER_IDS_MSG,
    })
    .min(1, MEMBER_IDS_MSG),
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
  if (pgMessage.startsWith('no_new_members')) {
    return errorResponse(400, 'no_new_members', 'Everyone selected is already in the group.');
  }
  if (pgMessage.startsWith('member_not_found')) {
    return errorResponse(400, 'member_not_found', 'One of the selected members does not exist.');
  }
  if (pgMessage.startsWith('too_many_members')) {
    return errorResponse(400, 'too_many_members', pgMessage);
  }

  console.error('add-group-members: unmapped DB error:', pgMessage);
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
    console.error('add-group-members: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(AddGroupMembersRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

  const db = serviceRoleClient();
  const { data, error } = await db.rpc('fn_add_group_members', {
    p_group_thread_id: payload.group_thread_id,
    p_actor_id: user.id,
    p_member_ids: payload.member_ids,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { added_count: data as number });
});
