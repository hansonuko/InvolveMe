// POST /functions/v1/create-group-avatar-upload-url
//
// Group-avatar counterpart to create-profile-upload-url — mints a signed
// upload URL into the same public `profile-media` bucket
// (20260918110000_profile_media_and_two_step.sql), under
// `groups/${group_thread_id}.jpg` instead of `${user.id}/avatar.jpg`. The
// signed token itself authorizes the storage write (same posture that
// migration's own header comment documents), so the real gate is here:
// only a current admin of the group can be handed a token for its path —
// checked directly against group_members rather than via a SECURITY
// DEFINER RPC, since this is a plain read, not a mutation (CLAUDE.md rule
// #1 only requires that posture for money/identity-sensitive writes).
// `avatar_url` itself only ever changes via fn_update_group_profile
// (update-group-profile) after the upload succeeds — this function never
// touches group_threads.

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface CreateGroupAvatarUploadUrlRequestBody {
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Use POST.');
  }

  let user;
  try {
    user = await requireAuthenticatedUser(req);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e.status, e.code, e.message);
    console.error('create-group-avatar-upload-url: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: CreateGroupAvatarUploadUrlRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (typeof payload.group_thread_id !== 'string') {
    return errorResponse(400, 'invalid_request', 'group_thread_id is required.');
  }

  const db = serviceRoleClient();

  const { data: membership, error: membershipError } = await db
    .from('group_members')
    .select('role')
    .eq('group_thread_id', payload.group_thread_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (membershipError) {
    console.error(
      'create-group-avatar-upload-url: membership check failed:',
      membershipError.message,
    );
    return errorResponse(500, 'internal_error', 'Something went wrong.');
  }
  if (!membership) {
    return errorResponse(403, 'not_a_member', 'You are not a member of this group.');
  }
  if (membership.role !== 'admin') {
    return errorResponse(403, 'not_admin', 'Only a group admin can change the group photo.');
  }

  const path = `groups/${payload.group_thread_id}.jpg`;

  const { data, error } = await db.storage
    .from('profile-media')
    .createSignedUploadUrl(path, { upsert: true });

  if (error) {
    console.error('create-group-avatar-upload-url: createSignedUploadUrl failed:', error.message);
    return errorResponse(500, 'internal_error', 'Could not create an upload URL.');
  }

  const { data: publicUrlData } = db.storage.from('profile-media').getPublicUrl(path);
  // Cache-busted, same reasoning create-profile-upload-url documents — a
  // stable path a re-upload overwrites in place, and Image caches by URL.
  const publicUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

  return json(200, {
    path: data.path,
    token: data.token,
    signed_url: data.signedUrl,
    public_url: publicUrl,
  });
});
