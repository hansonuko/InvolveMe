// POST /functions/v1/create-group-thread
//
// Wraps fn_create_group_thread (migration 20260918100000_free_group_
// messaging.sql) — the group-creation half of punch-list item 11 (free
// group messaging, no billing). No financial logic here (CLAUDE.md rule
// #1): this function only authenticates and forwards to the DB function,
// which does the validation + inserts. p_creator_id is always the
// authenticated caller's own id, never taken from the request body — the
// caller can't create a group "owned by" anyone else.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface CreateGroupThreadRequestBody {
  name?: string;
  member_ids?: string[];
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

// Maps fn_create_group_thread's `raise exception` messages to HTTP
// responses, same convention every other Edge Function here uses.
function mapCreateGroupThreadError(pgMessage: string): Response {
  if (pgMessage.startsWith('group_name_required')) {
    return errorResponse(400, 'group_name_required', 'A group needs a name.');
  }
  if (pgMessage.startsWith('group_name_too_long')) {
    return errorResponse(400, 'group_name_too_long', 'Group name is too long (60 characters max).');
  }
  if (pgMessage.startsWith('group_needs_members')) {
    return errorResponse(
      400,
      'group_needs_members',
      'Add at least one other member to create a group.',
    );
  }
  if (pgMessage.startsWith('too_many_members')) {
    return errorResponse(400, 'too_many_members', pgMessage);
  }
  if (pgMessage.startsWith('member_not_found')) {
    return errorResponse(400, 'member_not_found', 'One of the selected members does not exist.');
  }

  console.error('create-group-thread: unmapped DB error:', pgMessage);
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
    console.error('create-group-thread: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: CreateGroupThreadRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.name !== 'string' || payload.name.trim().length === 0) {
    return errorResponse(400, 'group_name_required', 'A group needs a name.');
  }
  if (
    !Array.isArray(payload.member_ids) ||
    !payload.member_ids.every((id) => typeof id === 'string')
  ) {
    return errorResponse(400, 'invalid_request', 'member_ids must be an array of user ids.');
  }

  const db = serviceRoleClient();
  const { data, error } = await db.rpc('fn_create_group_thread', {
    p_creator_id: user.id,
    p_name: payload.name,
    p_member_ids: payload.member_ids,
  });

  if (error) {
    return mapCreateGroupThreadError(error.message);
  }

  return json(200, { group_thread_id: data as string });
});
