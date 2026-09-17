// POST /functions/v1/create-status-upload-url
//
// Batch F (docs/10-UX-REFINEMENT-BACKLOG.md), the storage-pipeline
// prerequisite: mints a one-time signed upload URL for the caller's own
// status media, never a broad client-side credential onto the bucket
// (CLAUDE.md rule #10's "stay lite" spirit + this app's usual "never trust
// the client with a write credential" posture). The path is always
// `${user.id}/${uuid}.jpg` — server-derived from the verified JWT, not
// client-supplied, so nobody can request a signed URL into someone else's
// folder. `20260917140000_status_media_pipeline.sql`'s `status-media`
// bucket has no INSERT RLS policy for `authenticated` at all: the signed
// token itself, not a Postgres RLS row, is what authorizes the eventual
// upload — see that migration's own comment.
//
// The client uploads directly to the returned `signed_url` using the
// returned `token` (supabase-js's `storage.uploadToSignedUrl`), then calls
// post-status with the same `path` as `media_path` once the upload
// succeeds. This function never touches status_updates or the ledger —
// no financial logic here (CLAUDE.md rule #1).

import { AuthError, requireAuthenticatedUser, serviceRoleClient } from '../_shared/auth.ts';

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
    console.error('create-status-upload-url: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  const path = `${user.id}/${crypto.randomUUID()}.jpg`;

  const db = serviceRoleClient();
  const { data, error } = await db.storage.from('status-media').createSignedUploadUrl(path);

  if (error) {
    console.error('create-status-upload-url: createSignedUploadUrl failed:', error.message);
    return errorResponse(500, 'internal_error', 'Could not create an upload URL.');
  }

  return json(200, {
    path: data.path,
    token: data.token,
    signed_url: data.signedUrl,
  });
});
