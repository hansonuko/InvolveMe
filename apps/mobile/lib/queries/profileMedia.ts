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
 * uploadStatusMedia already establishes in lib/queries/status.ts. */
export async function uploadProfileMedia(localUri: string, path: string, token: string) {
  const response = await fetch(localUri);
  const blob = await response.blob();
  const { error } = await supabase.storage
    .from('profile-media')
    .uploadToSignedUrl(path, token, blob);
  if (error) throw error;
}
