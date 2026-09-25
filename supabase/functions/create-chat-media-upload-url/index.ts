// POST /functions/v1/create-chat-media-upload-url
//
// docs/16-CHAT-MEDIA-SCOPING.md §4 — mints a one-time signed upload URL for
// the caller's own chat photo, same shape as create-status-upload-url
// (never a broad client-side credential onto the bucket). The path is
// always `${user.id}/${uuid}.jpg` — server-derived from the verified JWT,
// never client-supplied, so nobody can request a signed URL into someone
// else's folder, AND (unlike status's own pipeline — see this session's
// migration header comment) this exact prefix is what fn_send_message
// checks p_media_path against before ever charging or inserting a
// message, so a fabricated path can't reference another user's real
// upload slot either. `chat-media`'s own bucket
// (20260925120000_chat_media_pipeline.sql) has no INSERT RLS policy for
// `authenticated` at all — the signed token itself is what authorizes the
// eventual upload, not a Postgres row.
//
// The client uploads directly to the returned `signed_url` using the
// returned `token` (supabase-js's `storage.uploadToSignedUrl`), then calls
// send-message with the same `path` as `media_path` once the upload
// succeeds. This function never touches messages or the ledger — no
// financial logic here (CLAUDE.md rule #1).

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
    console.error('create-chat-media-upload-url: auth check threw unexpectedly:', e);
    return errorResponse(500, 'internal_error', 'Auth check failed.');
  }

  const path = `${user.id}/${crypto.randomUUID()}.jpg`;

  const db = serviceRoleClient();
  const { data, error } = await db.storage.from('chat-media').createSignedUploadUrl(path);

  if (error) {
    console.error('create-chat-media-upload-url: createSignedUploadUrl failed:', error.message);
    return errorResponse(500, 'internal_error', 'Could not create an upload URL.');
  }

  return json(200, {
    path: data.path,
    token: data.token,
    signed_url: data.signedUrl,
  });
});
