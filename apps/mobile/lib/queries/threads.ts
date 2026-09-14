import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

export interface ThreadWithPartner {
  id: string;
  participant_a: string;
  participant_b: string;
  is_blocked: boolean;
  last_message_at: string | null;
  created_at: string;
  /** The other participant, relative to the current user — resolved client-side below. */
  partner: {
    id: string;
    display_name: string | null;
    avatar_url: string | null;
  };
  /** Real last-message text, resolved client-side below — `null` until a
   * thread has at least one message. */
  last_message_body: string | null;
  /** From the `thread_unread_counts` view (migration
   * 20260914080000_thread_read_cursor.sql) — messages from the *other*
   * participant sent after the caller's own read cursor. `0` for a thread
   * with no messages at all (the view has no row for it in that case). */
  unread_count: number;
}

/**
 * Threads the current user participates in, newest activity first, each
 * joined with the *other* participant's basic profile fields.
 *
 * Two queries rather than one embedded select: `threads` has two FKs to
 * `users` (participant_a and participant_b), and disambiguating that via
 * PostgREST's embedding syntax needs the exact constraint names — a plain
 * follow-up `.in('id', partnerIds)` is simpler to read and doesn't depend on
 * a migration's internal naming staying stable.
 */
export function useThreads(currentUserId: string | undefined) {
  return useQuery({
    queryKey: ['threads', currentUserId],
    enabled: !!currentUserId,
    queryFn: async (): Promise<ThreadWithPartner[]> => {
      const { data: threads, error } = await supabase
        .from('threads')
        .select('id, participant_a, participant_b, is_blocked, last_message_at, created_at')
        .or(`participant_a.eq.${currentUserId},participant_b.eq.${currentUserId}`)
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (error) throw error;
      if (!threads?.length) return [];

      const partnerIds = threads.map((t) =>
        t.participant_a === currentUserId ? t.participant_b : t.participant_a,
      );

      const { data: partners, error: partnersError } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in('id', partnerIds);

      if (partnersError) throw partnersError;

      const partnersById = new Map((partners ?? []).map((p) => [p.id, p]));

      // Last-message preview: one more query rather than a per-thread
      // subselect, same "simpler to read than PostgREST embedding" call as
      // the partner join above. Ordered newest-first so the first row seen
      // per thread_id is the one to keep.
      const threadIds = threads.map((t) => t.id);
      const { data: recentMessages, error: messagesError } = await supabase
        .from('messages')
        .select('thread_id, body, created_at')
        .in('thread_id', threadIds)
        .order('created_at', { ascending: false });

      if (messagesError) throw messagesError;

      const lastBodyByThreadId = new Map<string, string>();
      for (const m of recentMessages ?? []) {
        if (!lastBodyByThreadId.has(m.thread_id)) {
          lastBodyByThreadId.set(m.thread_id, m.body);
        }
      }

      // Unread counts: a separate query against the view rather than a
      // PostgREST embed, same reasoning as the two joins above — no FK
      // from `threads` to a view for embedding syntax to hang off of
      // anyway. No explicit filter needed: `thread_unread_counts` is
      // already scoped to the caller's own threads via `auth.uid()`
      // inside the view (security_invoker — see the migration).
      const { data: unreadRows, error: unreadError } = await supabase
        .from('thread_unread_counts')
        .select('thread_id, unread_count');

      if (unreadError) throw unreadError;

      const unreadByThreadId = new Map(
        (unreadRows ?? []).map((r) => [r.thread_id, r.unread_count as number]),
      );

      return threads.map((t) => {
        const partnerId = t.participant_a === currentUserId ? t.participant_b : t.participant_a;
        const partner = partnersById.get(partnerId);
        return {
          ...t,
          partner: partner ?? { id: partnerId, display_name: null, avatar_url: null },
          last_message_body: lastBodyByThreadId.get(t.id) ?? null,
          unread_count: unreadByThreadId.get(t.id) ?? 0,
        };
      });
    },
  });
}

/** Sum of unread_count across every one of the caller's threads — drives
 * the Chats tab's `tabBarBadge` in (tabs)/_layout.tsx. A separate,
 * cheaper query rather than reusing useThreads' full result, since the
 * tab bar (which renders on every screen, not just Chats) has no reason
 * to also fetch partner profiles and message previews just to get one
 * number. */
export function useTotalUnreadCount(userId: string | undefined) {
  return useQuery({
    queryKey: ['totalUnreadCount', userId],
    enabled: !!userId,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.from('thread_unread_counts').select('unread_count');
      if (error) throw error;
      return (data ?? []).reduce((sum, r) => sum + (r.unread_count as number), 0);
    },
    // No realtime channel for this (see useLedgerEntries' comment on the
    // same tradeoff — piggybacking on wallets' channel doesn't apply
    // here, and threads/messages aren't on supabase_realtime either);
    // a short poll is a reasonable safety net for something rendered on
    // every screen, cheap to over-fetch since it's a single small query.
    refetchInterval: 15000,
  });
}

interface MarkThreadReadResponse {
  ok: boolean;
}

/** Wraps POST /functions/v1/mark-thread-read — called on entering a
 * thread (see thread/[id].tsx). Invalidates both the thread list and the
 * tab-bar total so the badges clear without waiting for Chats' own
 * pull-to-refresh or the total's next poll tick. */
export function useMarkThreadRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (threadId: string) =>
      callEdgeFunction<MarkThreadReadResponse>('mark-thread-read', { thread_id: threadId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['totalUnreadCount'] });
    },
  });
}
