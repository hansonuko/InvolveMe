// POST /functions/v1/update-group-profile
//
// Wraps fn_update_group_profile (migration 20260919120000_group_admin_actions.sql)
// — admin-only rename/description/avatar update. Each field is optional:
// omit it (or send null) to leave it unchanged. p_actor_id is always the
// authenticated caller's own id.

import { z } from 'npm:zod@^3.23';
import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';
import { parseBody, requiredString } from '../_shared/validate.ts';

const OPTIONAL_FIELDS_MSG = 'name, description, and avatar_url must be strings.';
const optionalNullableString = () =>
  z.string({ invalid_type_error: OPTIONAL_FIELDS_MSG }).nullable().optional();

const UpdateGroupProfileRequestSchema = z.object({
  group_thread_id: requiredString('group_thread_id'),
  name: optionalNullableString(),
  description: optionalNullableString(),
  avatar_url: optionalNullableString(),
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

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  const parsed = parseBody(UpdateGroupProfileRequestSchema, rawBody);
  if (!parsed.success) return parsed.response;
  const payload = parsed.data;

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
