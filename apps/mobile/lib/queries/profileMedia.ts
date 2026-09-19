import { useMutation } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

interface CreateProfileUploadUrlResponse {
  path: string;
  token: string;
  signed_url: string;
  /** Already cache-busted (a `?t=` query param) — this is what should be
   * written straight onto `users.avatar_url`/`cover_url` once the upload
   * itself succeeds, via the plain useUpdateProfile mutation. */
  public_url: string;
}

/** Wraps POST /functions/v1/create-profile-upload-url — mints a one-time
 * signed upload slot in the public `profile-media` bucket for the
 * caller's own avatar or cover photo. Same "never a long-lived
 * credential" contract useCreateStatusUploadUrl already documents. */
export function useCreateProfileUploadUrl() {
  return useMutation({
    mutationFn: (kind: 'avatar' | 'cover') =>
      callEdgeFunction<CreateProfileUploadUrlResponse>('create-profile-upload-url', { kind }),
  });
}

/** Uploads a local file (camera capture or gallery pick, already resized/
 * compressed by the caller) to the path a signed upload URL was minted
 * for — same `fetch` + `.blob()` + `uploadToSignedUrl` shape
 * uploadStatusMedia already establishes in lib/queries/status.ts.
 *
 * The Blob itself must carry the correct `type` — re-wrapping via
 * `new Blob([...], { type })` rather than trusting `response.blob()`'s own
 * type (RN's `fetch(file://...).blob()` frequently leaves it empty/wrong)
 * or passing `uploadToSignedUrl`'s `fileOptions.contentType` (confirmed
 * live, session 21: storage-js's `uploadToSignedUrl` only reads
 * `fileOptions.contentType` on its raw-body/ReadableStream code path — for
 * a `Blob` body it takes the FormData branch instead, which never looks at
 * `fileOptions` at all and relies entirely on the Blob's own `.type` for
 * the multipart part's content type. Passing `fileOptions.contentType`
 * alongside a Blob is a silent no-op, not a smaller version of this fix).
 * Without this, every upload was hitting `profile-media`'s JPEG/PNG-only
 * bucket policy with the wrong mime type and getting rejected. The caller
 * (settings/profile.tsx) always produces JPEG via
 * `ImageManipulator.SaveFormat.JPEG`, so the literal is never a guess.
 *
 * Re-wraps the fetched Blob as `new Blob([original], { type })` rather
 * than reading bytes into an `ArrayBuffer` — React Native's own `Blob`
 * polyfill (`BlobManager.createFromParts`) explicitly throws on
 * `ArrayBuffer`/`ArrayBufferView` parts ("are not supported"); it only
 * accepts other `Blob`s or strings. Wrapping an existing Blob to override
 * its `type` is the one construction RN actually supports. */
export async function uploadProfileMedia(localUri: string, path: string, token: string) {
  const response = await fetch(localUri);
  const original = await response.blob();
  const blob = new Blob([original], { type: 'image/jpeg' });
  const { error } = await supabase.storage
    .from('profile-media')
    .uploadToSignedUrl(path, token, blob);
  if (error) throw error;
}
