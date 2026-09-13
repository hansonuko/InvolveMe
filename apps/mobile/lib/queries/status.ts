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
