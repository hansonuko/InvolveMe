import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

export interface StatusUpdate {
  id: string;
  media_url: string | null;
  caption: string | null;
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
        .select('id, media_url, caption, credits_charged, expires_at, created_at')
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

/** Wraps POST /functions/v1/post-status. Text-only for now — no media
 * upload UI yet (needs Supabase Storage wiring, out of scope here). */
export function usePostStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (caption: string) =>
      callEdgeFunction<PostStatusResponse>('post-status', { caption }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['status_updates'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
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
        .select('id, user_id, media_url, caption, credits_charged, expires_at, created_at')
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
          media_url: s.media_url,
          caption: s.caption,
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
      return [...grouped.values()];
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
