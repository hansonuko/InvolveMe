import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { useRealtimeTableChanges } from '@/lib/realtimeChannel';
import { supabase } from '@/lib/supabase';

export interface ThreadWithPartner {
  id: string;
  participant_a: string;
  participant_b: string;
  /** Who blocked this thread, if anyone — `null` means not blocked. Only
   * the user this equals can unblock it (see fn_set_thread_blocked's
   * comment in migration 20260914090000_settings_privacy_reports_push.sql
   * for why a plain boolean couldn't support that rule). */
  blocked_by: string | null;
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
 *
 * Kept live via Realtime on `threads` itself (punch-list item 4,
 * 2026-09-19) — `fn_send_message` updates a thread's own
 * `last_message_at` in the same transaction as every INSERT into
 * `messages` (confirmed by reading the function, not assumed), so
 * subscribing to `threads` changes is sufficient to refresh the whole
 * list — preview text, ordering, and unread counts all live inside this
 * query's own `queryFn` and get recomputed together on any invalidation,
 * without a second subscription on `messages` for the same event. No
 * `filter` on the subscription: Realtime enforces `threads_select_participant`
 * RLS on every `postgres_changes` delivery regardless, and that policy
 * already expresses the exact "either participant column" condition a
 * single Realtime `filter` string can't (it only supports one column
 * comparison, not an OR across two).
 */
export function useThreads(currentUserId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['threads', currentUserId];

  const query = useQuery({
    queryKey,
    enabled: !!currentUserId,
    queryFn: async (): Promise<ThreadWithPartner[]> => {
      const { data: threads, error } = await supabase
        .from('threads')
        .select('id, participant_a, participant_b, blocked_by, last_message_at, created_at')
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

  useRealtimeTableChanges(
    currentUserId ? `threads:${currentUserId}` : undefined,
    { event: '*', schema: 'public', table: 'threads' },
    () => {
      queryClient.invalidateQueries({ queryKey });
    },
  );

  return query;
}

/** Sum of unread_count across every one of the caller's threads — drives
 * the Chats tab's `tabBarBadge` in (tabs)/_layout.tsx. A separate,
 * cheaper query rather than reusing useThreads' full result, since the
 * tab bar (which renders on every screen, not just Chats) has no reason
 * to also fetch partner profiles and message previews just to get one
 * number. */
export function useTotalUnreadCount(userId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['totalUnreadCount', userId];

  const query = useQuery({
    queryKey,
    enabled: !!userId,
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.from('thread_unread_counts').select('unread_count');
      if (error) throw error;
      return (data ?? []).reduce((sum, r) => sum + (r.unread_count as number), 0);
    },
  });

  // `thread_unread_counts` is a view, not a table — it can't be added to
  // the publication directly. `threads` now is (punch-list item 4,
  // 2026-09-19, this same session), and every new message updates a
  // thread's own `last_message_at` in the same transaction, so
  // piggybacking on that change is enough to know this count needs
  // recomputing — same "reuse an already-published table's changes"
  // idiom useLedgerEntries already established for wallets/ledger_entries.
  // Own distinct topic (not literally `useThreads`' `threads:${userId}`
  // topic string) for the same loose-coupling reason that pattern uses a
  // separate topic from `useWallets`, even though both listen to the same
  // table/filter.
  useRealtimeTableChanges(
    userId ? `unread-count-via-threads:${userId}` : undefined,
    { event: '*', schema: 'public', table: 'threads' },
    () => queryClient.invalidateQueries({ queryKey }),
  );

  return query;
}

interface StartThreadResponse {
  thread_id: string;
}

/** Wraps POST /functions/v1/start-thread — resolves/creates a thread with
 * another user without sending a message, for "tap a found user, go
 * straight into their chat" (see NewChatModal in chats.tsx). Idempotent:
 * calling this again for the same pair just returns the existing thread. */
export function useStartThread() {
  return useMutation({
    mutationFn: (recipientId: string) =>
      callEdgeFunction<StartThreadResponse>('start-thread', { recipient_id: recipientId }),
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

interface SetThreadBlockedResponse {
  ok: boolean;
  blocked: boolean;
}

/** Wraps POST /functions/v1/set-thread-blocked — the actual write half of
 * blocking (docs/00-SESSION-HANDOFF.md: enforcement already existed,
 * nothing ever set it). Called both from a thread's own overflow menu
 * (block) and from the Settings > Privacy > Blocked list (unblock). */
export function useSetThreadBlocked() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: { threadId: string; blocked: boolean }) =>
      callEdgeFunction<SetThreadBlockedResponse>('set-thread-blocked', {
        thread_id: params.threadId,
        blocked: params.blocked,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['blockedThreads'] });
    },
  });
}

interface SetThreadMutedResponse {
  ok: boolean;
  muted: boolean;
}

/** Wraps POST /functions/v1/set-thread-muted — sets the caller's own
 * per-thread notification-mute flag (docs/10-UX-REFINEMENT-BACKLOG.md Batch
 * G). Called from a thread's own overflow menu, mirroring
 * useSetThreadBlocked's shape. `useThreadHeaderInfo` in thread/[id].tsx is a
 * one-shot fetch (not a TanStack Query), so there's no query key to
 * invalidate here — the caller bumps its own refetch key on success, same
 * as it already does for block/unblock. Unlike blocking, mute has no "who
 * can toggle it back" asymmetry, so there's no separate settings-list hook.
 */
export function useSetThreadMuted() {
  return useMutation({
    mutationFn: (params: { threadId: string; muted: boolean }) =>
      callEdgeFunction<SetThreadMutedResponse>('set-thread-muted', {
        thread_id: params.threadId,
        muted: params.muted,
      }),
  });
}

export interface BlockedThread {
  thread_id: string;
  partner: { id: string; display_name: string | null };
}

/** Threads the *current user* blocked (never ones where the other
 * participant blocked them — `blocked_by` makes that distinction
 * possible, which a plain boolean couldn't) — for Settings > Privacy's
 * "Blocked contacts" list. */
export function useBlockedThreads(currentUserId: string | undefined) {
  return useQuery({
    queryKey: ['blockedThreads', currentUserId],
    enabled: !!currentUserId,
    queryFn: async (): Promise<BlockedThread[]> => {
      const { data: threads, error } = await supabase
        .from('threads')
        .select('id, participant_a, participant_b')
        .eq('blocked_by', currentUserId);

      if (error) throw error;
      if (!threads?.length) return [];

      const partnerIds = threads.map((t) =>
        t.participant_a === currentUserId ? t.participant_b : t.participant_a,
      );
      const { data: partners, error: partnersError } = await supabase
        .from('users')
        .select('id, display_name')
        .in('id', partnerIds);
      if (partnersError) throw partnersError;

      const partnersById = new Map((partners ?? []).map((p) => [p.id, p]));

      return threads.map((t) => {
        const partnerId = t.participant_a === currentUserId ? t.participant_b : t.participant_a;
        return {
          thread_id: t.id,
          partner: partnersById.get(partnerId) ?? { id: partnerId, display_name: null },
        };
      });
    },
  });
}
