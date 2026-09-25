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
 * otherwise need.
 *
 * The Blob itself must carry the correct `type` — re-wrapping via
 * `new Blob([original], { type })` rather than trusting `response.blob()`'s
 * own type (RN's `fetch(file://...).blob()` frequently leaves it
 * empty/wrong) or passing `uploadToSignedUrl`'s `fileOptions.contentType`
 * (confirmed live, session 21: storage-js's `uploadToSignedUrl` only reads
 * `fileOptions.contentType` on its raw-body/ReadableStream code path — for
 * a `Blob` body it takes the FormData branch instead, which never looks at
 * `fileOptions` at all and relies entirely on the Blob's own `.type` for
 * the multipart part's content type. Passing `fileOptions.contentType`
 * alongside a Blob is a silent no-op, not a smaller version of this fix).
 * Deliberately `new Blob([original], ...)`, not `new Blob([arrayBuffer],
 * ...)` — React Native's own `Blob` polyfill (`BlobManager.createFromParts`)
 * explicitly throws on `ArrayBuffer`/`ArrayBufferView` parts; it only
 * accepts other `Blob`s or strings, so wrapping the existing Blob is the
 * one construction that actually works on-device, not just in Node.
 * Without this, every status photo upload was hitting `status-media`'s
 * JPEG/PNG-only bucket policy with the wrong mime type and getting
 * rejected. StatusComposer always produces JPEG via
 * `ImageManipulator.SaveFormat.JPEG`, so the literal is never a guess. */
export async function uploadStatusMedia(localUri: string, path: string, token: string) {
  const response = await fetch(localUri);
  const original = await response.blob();
  const blob = new Blob([original], { type: 'image/jpeg' });
  const { error } = await supabase.storage
    .from('status-media')
    .uploadToSignedUrl(path, token, blob);
  if (error) throw error;
}

/** Whether the current user has liked a status (punch-list item 4a,
 * 2026-09-19) — a lightweight, free reaction, not a message; see
 * `20260919110000_status_likes.sql`'s own header comment for why this is
 * a direct RLS-gated table (same "useDeleteStatus" precedent) rather than
 * a SECURITY DEFINER function. */
export function useStatusLiked(statusId: string | undefined, userId: string | undefined) {
  return useQuery({
    queryKey: ['statusLiked', statusId, userId],
    enabled: !!statusId && !!userId,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('status_likes')
        .select('status_id')
        .eq('status_id', statusId as string)
        .eq('liker_id', userId as string)
        .maybeSingle();
      if (error) throw error;
      return !!data;
    },
  });
}

/** Toggles a like on/off — a plain insert/delete against `status_likes`,
 * RLS-enforced (see that migration for the exact "can only like a status
 * you could actually see" WITH CHECK condition). */
export function useToggleStatusLike() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      statusId,
      userId,
      liked,
    }: {
      statusId: string;
      userId: string;
      liked: boolean;
    }) => {
      if (liked) {
        const { error } = await supabase
          .from('status_likes')
          .delete()
          .eq('status_id', statusId)
          .eq('liker_id', userId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('status_likes')
          .insert({ status_id: statusId, liker_id: userId });
        if (error) throw error;
      }
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['statusLiked', variables.statusId, variables.userId],
      });
    },
  });
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

export interface StatusViewer {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  /** When this person viewed the status. */
  viewed_at: string;
  /** When this person also liked it — `null` if they viewed but never
   * liked. Never populated without `viewed_at` also being set in this
   * app's actual flow (StoryViewer marks a status viewed the moment it's
   * displayed, before the like button is even reachable), but a like row
   * with no matching view row is still included by union rather than
   * silently dropped, in case that invariant is ever loosened. */
  liked_at: string | null;
}

/** Poster-only "who viewed this status, and whether they also liked it" —
 * one combined list, not two separate surfaces, matching WhatsApp: tapping
 * the eye icon shows every viewer, with a small heart next to whichever
 * ones also liked, rather than a separate "liked by" entry point. Built
 * from the union of `status_views` and `status_likes` (both already
 * poster-readable via `status_views_select_as_poster` /
 * `status_likes_select_as_poster`) rather than starting from viewers alone
 * and annotating likes onto them — a like without a matching view row
 * "shouldn't" happen given the auto-view-on-display flow, but this way it
 * still shows up instead of being silently dropped if that ever changes.
 * Sorted most-recent-first by whichever timestamp is later (a like always
 * happens at or after its own view in practice, so this is effectively
 * "most recently viewed first" — WhatsApp's own ordering). */
export function useStatusViewers(statusId: string | undefined) {
  return useQuery({
    queryKey: ['statusViewers', statusId],
    enabled: !!statusId,
    queryFn: async (): Promise<StatusViewer[]> => {
      const [{ data: views, error: viewsError }, { data: likes, error: likesError }] =
        await Promise.all([
          supabase
            .from('status_views')
            .select('viewer_id, viewed_at')
            .eq('status_id', statusId as string),
          supabase
            .from('status_likes')
            .select('liker_id, created_at')
            .eq('status_id', statusId as string),
        ]);
      if (viewsError) throw viewsError;
      if (likesError) throw likesError;

      const likedAtByUserId = new Map((likes ?? []).map((l) => [l.liker_id, l.created_at]));
      const viewedAtByUserId = new Map((views ?? []).map((v) => [v.viewer_id, v.viewed_at]));
      const userIds = new Set([...viewedAtByUserId.keys(), ...likedAtByUserId.keys()]);
      if (!userIds.size) return [];

      const { data: users, error: usersError } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in('id', [...userIds]);
      if (usersError) throw usersError;

      const userById = new Map((users ?? []).map((u) => [u.id, u]));
      return [...userIds]
        .map((id) => {
          const user = userById.get(id);
          const viewedAt = viewedAtByUserId.get(id);
          const likedAt = likedAtByUserId.get(id) ?? null;
          return {
            id,
            display_name: user?.display_name ?? null,
            avatar_url: user?.avatar_url ?? null,
            // Falls back to the like's own timestamp on the (shouldn't-
            // happen) union-only case described above, rather than an
            // empty string that would sort unpredictably.
            viewed_at: viewedAt ?? likedAt ?? new Date(0).toISOString(),
            liked_at: likedAt,
          };
        })
        .sort((a, b) => {
          const aLatest = a.liked_at && a.liked_at > a.viewed_at ? a.liked_at : a.viewed_at;
          const bLatest = b.liked_at && b.liked_at > b.viewed_at ? b.liked_at : b.viewed_at;
          return bLatest.localeCompare(aLatest);
        });
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
