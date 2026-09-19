// POST /functions/v1/update-group-profile
//
// Wraps fn_update_group_profile (migration 20260919120000_group_admin_actions.sql)
// — admin-only rename/description/avatar update. Each field is optional:
// omit it (or send null) to leave it unchanged. p_actor_id is always the
// authenticated caller's own id.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface UpdateGroupProfileRequestBody {
  group_thread_id?: string;
  name?: string | null;
  description?: string | null;
  avatar_url?: string | null;
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
    return errorResponse(403, 'not_admin', 'Only a group admin can edit group info.');
  }
  if (pgMessage.startsWith('group_name_required')) {
    return errorResponse(400, 'group_name_required', 'A group needs a name.');
  }
  if (pgMessage.startsWith('group_name_too_long')) {
    return errorResponse(400, 'group_name_too_long', 'Group name is too long (60 characters max).');
  }
  if (pgMessage.startsWith('group_description_too_long')) {
    return errorResponse(
      400,
      'group_description_too_long',
      'Group description is too long (500 characters max).',
    );
  }

  console.error('update-group-profile: unmapped DB error:', pgMessage);
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
    console.error('update-group-profile: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: UpdateGroupProfileRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.group_thread_id !== 'string') {
    return errorResponse(400, 'invalid_request', 'group_thread_id is required.');
  }
  if (
    (payload.name !== undefined && payload.name !== null && typeof payload.name !== 'string') ||
    (payload.description !== undefined &&
      payload.description !== null &&
      typeof payload.description !== 'string') ||
    (payload.avatar_url !== undefined &&
      payload.avatar_url !== null &&
      typeof payload.avatar_url !== 'string')
  ) {
    return errorResponse(
      400,
      'invalid_request',
      'name, description, and avatar_url must be strings.',
    );
  }

  const db = serviceRoleClient();
  const { error } = await db.rpc('fn_update_group_profile', {
    p_group_thread_id: payload.group_thread_id,
    p_actor_id: user.id,
    p_name: payload.name ?? null,
    p_description: payload.description ?? null,
    p_avatar_url: payload.avatar_url ?? null,
  });

  if (error) {
    return mapError(error.message);
  }

  return json(200, { ok: true });
});
