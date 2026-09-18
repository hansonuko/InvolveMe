import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

export interface StatusUpdate {
  id: string;
  media_path: string | null;
  caption: string | null;
  text_style: string | null;
  credits_charged: number;
  expires_at: string;
  created_at: string;
}

/** The current user's own status updates — per docs/02-DATA-MODEL.md's RLS
 * migration comment, `status_updates_select_own` only exposes a user's own
 * rows for now (visibility to contacts/thread partners is a Status-feature
 * product decision not made yet, not something to guess at here). */
export function useMyStatusUpdates(userId: string | undefined) {
  return useQuery({
    queryKey: ['status_updates', userId],
    enabled: !!userId,
    queryFn: async (): Promise<StatusUpdate[]> => {
      const { data, error } = await supabase
        .from('status_updates')
        .select('id, media_path, caption, text_style, credits_charged, expires_at, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return data ?? [];
    },
  });
}

interface PostStatusResponse {
  status_id: string;
  credits_charged: number;
  payer_balance_after: number;
}

/** Wraps POST /functions/v1/post-status. `mediaPath` is a `status-media`
 * object path already uploaded via `useCreateStatusUploadUrl` +
 * `uploadStatusMedia` — never a client-computed public URL. */
export function usePostStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { caption?: string; mediaPath?: string; textStyle?: string }) =>
      callEdgeFunction<PostStatusResponse>('post-status', {
        caption: params.caption,
        media_path: params.mediaPath,
        text_style: params.textStyle,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['status_updates'] });
      queryClient.invalidateQueries({ queryKey: ['statusFeed'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });
}

interface CreateStatusUploadUrlResponse {
  path: string;
  token: string;
  signed_url: string;
}

/** Wraps POST /functions/v1/create-status-upload-url — mints a one-time
 * signed upload slot in the private `status-media` bucket. Never returns
 * a long-lived credential; the token is single-use per Supabase Storage's
 * own signed-upload-URL mechanism. */
export function useCreateStatusUploadUrl() {
  return useMutation({
    mutationFn: () => callEdgeFunction<CreateStatusUploadUrlResponse>('create-status-upload-url'),
  });
}

/** Uploads a local file (camera capture or gallery pick, already resized/
 * compressed by the caller — see components/status/StatusComposer.tsx) to
 * the path a signed upload URL was minted for. `fetch` on a local `file://`
 * URI + `.blob()` is the standard RN/Expo way to get uploadable bytes
 * without a separate `expo-file-system` dependency this app doesn't
 * otherwise need. */
export async function uploadStatusMedia(localUri: string, path: string, token: string) {
  const response = await fetch(localUri);
  const blob = await response.blob();
  const { error } = await supabase.storage
    .from('status-media')
    .uploadToSignedUrl(path, token, blob);
  if (error) throw error;
}

/** Signed read URL for a status-media object — the bucket is private, so
 * this is the only way to actually display one. Fails (throws) if the
 * caller isn't allowed to see it, per `status_media_select_visible` RLS
 * (20260917140000_status_media_pipeline.sql) — the same visibility rule
 * status_updates itself already enforces, not a separate access model. */
export function useStatusMediaUrl(mediaPath: string | null) {
  return useQuery({
    queryKey: ['statusMediaUrl', mediaPath],
    enabled: !!mediaPath,
    staleTime: 60 * 1000,
    queryFn: async (): Promise<string> => {
      const { data, error } = await supabase.storage
        .from('status-media')
        .createSignedUrl(mediaPath as string, 3600);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}

/** Poster-only view count (docs/10 item 4 — "visible to the poster only").
 * `status_views_select_as_poster` RLS is what actually enforces this: a
 * non-poster's equivalent query just returns 0 rows, not an error. */
export function useStatusViewCount(statusId: string | undefined) {
  return useQuery({
    queryKey: ['statusViewCount', statusId],
    enabled: !!statusId,
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('status_views')
        .select('*', { count: 'exact', head: true })
        .eq('status_id', statusId as string);
      if (error) throw error;
      return count ?? 0;
    },
  });
}

/** Self-serve delete (docs/10 item 5 — "no new function needed, a direct
 * RLS-scoped delete is safe here"). Order matters: the Storage object must
 * be removed *before* the status_updates row, never after — the storage
 * bucket's own DELETE RLS policy authorizes via `exists (select 1 from
 * status_updates where media_path = name and user_id = auth.uid())`, which
 * has nothing left to match once the status_updates row is already gone
 * (see 20260917140000_status_media_pipeline.sql's own comment on this same
 * ordering hazard). A status with no media skips the storage step
 * entirely. */
export function useDeleteStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (status: Pick<StatusUpdate, 'id' | 'media_path'>) => {
      if (status.media_path) {
        const { error: storageError } = await supabase.storage
          .from('status-media')
          .remove([status.media_path]);
        if (storageError) throw storageError;
      }
      const { error } = await supabase.from('status_updates').delete().eq('id', status.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['status_updates'] });
      queryClient.invalidateQueries({ queryKey: ['statusFeed'] });
    },
  });
}

interface StatusPoster {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface StatusFeedGroup {
  poster: StatusPoster;
  statuses: StatusUpdate[]; // newest first
  hasUnseen: boolean;
}

/** Other people's active statuses, grouped by poster — visibility is
 * enforced by status_updates_select_visible_to_thread_partner RLS (anyone
 * with a non-blocked thread with the poster), so the `.neq` below is a
 * shape/UX filter (excluding your own posts, which render separately in
 * the composer section above), not the actual access-control boundary. */
export function useStatusFeed(userId: string | undefined) {
  return useQuery({
    queryKey: ['statusFeed', userId],
    enabled: !!userId,
    queryFn: async (): Promise<StatusFeedGroup[]> => {
      const { data: statuses, error: statusesError } = await supabase
        .from('status_updates')
        .select(
          'id, user_id, media_path, caption, text_style, credits_charged, expires_at, created_at',
        )
        .neq('user_id', userId as string)
        .order('created_at', { ascending: false });
      if (statusesError) throw statusesError;
      if (!statuses?.length) return [];

      const posterIds = [...new Set(statuses.map((s) => s.user_id as string))];

      const [{ data: posters, error: postersError }, { data: views, error: viewsError }] =
        await Promise.all([
          supabase.from('users').select('id, display_name, avatar_url').in('id', posterIds),
          supabase
            .from('status_views')
            .select('status_id')
            .eq('viewer_id', userId as string),
        ]);
      if (postersError) throw postersError;
      if (viewsError) throw viewsError;

      const posterById = new Map((posters ?? []).map((p) => [p.id, p as StatusPoster]));
      const seenStatusIds = new Set((views ?? []).map((v) => v.status_id as string));

      const grouped = new Map<string, StatusFeedGroup>();
      for (const s of statuses) {
        const posterId = s.user_id as string;
        const existing = grouped.get(posterId);
        const status: StatusUpdate = {
          id: s.id,
          media_path: s.media_path,
          caption: s.caption,
          text_style: s.text_style,
          credits_charged: s.credits_charged,
          expires_at: s.expires_at,
          created_at: s.created_at,
        };
        const unseen = !seenStatusIds.has(s.id);
        if (existing) {
          existing.statuses.push(status);
          existing.hasUnseen = existing.hasUnseen || unseen;
        } else {
          grouped.set(posterId, {
            poster: posterById.get(posterId) ?? {
              id: posterId,
              display_name: null,
              avatar_url: null,
            },
            statuses: [status],
            hasUnseen: unseen,
          });
        }
      }
      // Two-tier sort (punch-list item 1, 2026-09-19): every poster with
      // at least one unseen status first, most-recent-first within that
      // group; posters whose statuses are all already seen move to the
      // end, also most-recent-first within that group. `statuses` within
      // each group is already newest-first (the query itself orders
      // `created_at desc`), so `statuses[0]` is always that poster's most
      // recent status. A poster's position updates live the moment their
      // last unseen status gets marked viewed and this query refetches
      // (useMarkStatusViewed invalidates `['statusFeed']`) — exactly the
      // "moves out of the unviewed row once viewed" behavior asked for.
      return [...grouped.values()].sort((a, b) => {
        if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
        return (
          new Date(b.statuses[0].created_at).getTime() -
          new Date(a.statuses[0].created_at).getTime()
        );
      });
    },
  });
}

/** Wraps POST /functions/v1/mark-status-viewed. */
export function useMarkStatusViewed() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (statusId: string) =>
      callEdgeFunction<{ ok: true }>('mark-status-viewed', { status_id: statusId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['statusFeed'] });
    },
  });
}
