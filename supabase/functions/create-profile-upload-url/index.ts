// POST /functions/v1/create-profile-upload-url
//
// Punch-list item 2 (2026-09-18/19): mints a signed upload URL for the
// caller's own avatar or cover photo, into the public `profile-media`
// bucket (20260918110000_profile_media_and_two_step.sql). The path is
// always `${user.id}/${kind}.jpg` — server-derived from the verified JWT,
// never client-supplied, so nobody can request a signed URL into someone
// else's folder, same posture create-status-upload-url already
// establishes. `upsert: true` lets a re-upload replace the previous
// photo at the same path rather than erroring on "already exists" — this
// bucket is deliberately one-photo-per-kind-per-user, not an append-only
// media history the way status is.
//
// The client uploads to `signed_url` with `token` (supabase-js's
// `storage.uploadToSignedUrl`), then writes the returned `public_url`
// directly onto `users.avatar_url`/`cover_url` itself via the plain
// client-side RLS-gated update every other profile field already uses
// (lib/queries/profile.ts's useUpdateProfile) — no separate "confirm
// upload" Edge Function needed, since setting avatar_url/cover_url has no
// financial or security logic behind it (CLAUDE.md rule #1's scope).

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

interface CreateProfileUploadUrlRequestBody {
  kind?: 'avatar' | 'cover';
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
    console.error('create-profile-upload-url: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  let payload: CreateProfileUploadUrlRequestBody;
  try {
    payload = await req.json();
  } catch {
    return errorResponse(400, 'invalid_request', 'Body must be valid JSON.');
  }

  if (payload.kind !== 'avatar' && payload.kind !== 'cover') {
    return errorResponse(400, 'invalid_request', 'kind must be "avatar" or "cover".');
  }

  const path = `${user.id}/${payload.kind}.jpg`;
  const db = serviceRoleClient();

  const { data, error } = await db.storage
    .from('profile-media')
    .createSignedUploadUrl(path, { upsert: true });

  if (error) {
    console.error('create-profile-upload-url: createSignedUploadUrl failed:', error.message);
    return errorResponse(500, 'internal_error', 'Could not create an upload URL.');
  }

  const { data: publicUrlData } = db.storage.from('profile-media').getPublicUrl(path);
  // Cache-busted: this is a stable path a re-upload overwrites in place,
  // and browsers/RN's Image cache by URL — without a changing query
  // param, a fresh upload could keep showing the old cached photo.
  const publicUrl = `${publicUrlData.publicUrl}?t=${Date.now()}`;

  return json(200, {
    path: data.path,
    token: data.token,
    signed_url: data.signedUrl,
    public_url: publicUrl,
  });
});
