import { useQuery } from '@tanstack/react-query';

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
   * thread has at least one message. Deliberately real, not a fabricated
   * preview: there is no unread-count concept in this schema yet (no
   * per-user last-read cursor), so the row only ever shows what's actually
   * true — see chats.tsx's ThreadRow for the corresponding decision not to
   * render a made-up unread badge. */
  last_message_body: string | null;
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

      return threads.map((t) => {
        const partnerId = t.participant_a === currentUserId ? t.participant_b : t.participant_a;
        const partner = partnersById.get(partnerId);
        return {
          ...t,
          partner: partner ?? { id: partnerId, display_name: null, avatar_url: null },
          last_message_body: lastBodyByThreadId.get(t.id) ?? null,
        };
      });
    },
  });
}
