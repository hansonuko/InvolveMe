import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export interface Profile {
  display_name: string | null;
  status_text: string | null;
  phone: string | null;
  read_receipts_enabled: boolean;
  last_seen_enabled: boolean;
}

/** The current user's own editable profile fields, plus phone (read-only
 * here — changing it is a real re-verification flow, not a Settings
 * field, see docs/00-SESSION-HANDOFF.md) and the read-receipts/last-seen
 * privacy flags. A plain read via the client, not an Edge Function — none
 * of this is financial. */
export function useProfile(userId: string | undefined) {
  return useQuery({
    queryKey: ['profile', userId],
    enabled: !!userId,
    queryFn: async (): Promise<Profile> => {
      const { data, error } = await supabase
        .from('users')
        .select('display_name, status_text, phone, read_receipts_enabled, last_seen_enabled')
        .eq('id', userId)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export interface PublicProfile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  status_text: string | null;
}

/** Another user's read-only public profile fields — for the "Profile"
 * action-sheet destination from a chat-list avatar tap. Deliberately a
 * narrower column set than `useProfile` (no `phone`/`read_receipts_enabled`)
 * even though `users_select_own_or_thread_partner` RLS would allow reading
 * the full row — good practice to only select what a *viewer* of someone
 * else's profile should see, not everything the row-level policy permits. */
export function usePublicProfile(userId: string | undefined) {
  return useQuery({
    queryKey: ['publicProfile', userId],
    enabled: !!userId,
    queryFn: async (): Promise<PublicProfile | null> => {
      // `.maybeSingle()`, not `.single()` — `users_select_own_or_thread_partner`
      // RLS (docs/02-DATA-MODEL.md §2) means this legitimately returns zero
      // rows for anyone the caller has no thread with yet, and `.single()`
      // throws on zero rows rather than resolving `data: null`. That throw
      // surfaced as a silently-blank profile screen (the query's own error
      // state was never checked) instead of an honest "not available" —
      // `null` here lets the screen render both states correctly.
      const { data, error } = await supabase
        .from('users')
        .select('id, display_name, avatar_url, status_text')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** Updates the caller's own display_name/status_text — both already
 * client-updatable per the RLS grant in rls_policies.sql (`grant update
 * (display_name, avatar_url, status_text) on public.users to
 * authenticated`), no new backend needed. Avatar upload isn't included —
 * deferred, see docs/00-SESSION-HANDOFF.md (needs a Storage bucket this
 * app doesn't have yet for any media type). */
export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { userId: string; displayName?: string; statusText?: string }) => {
      const update: Record<string, string> = {};
      if (params.displayName !== undefined) update.display_name = params.displayName;
      if (params.statusText !== undefined) update.status_text = params.statusText;

      const { error } = await supabase.from('users').update(update).eq('id', params.userId);
      if (error) throw error;
    },
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ['profile', params.userId] });
    },
  });
}

/** Read-receipts privacy toggle — new `read_receipts_enabled` column
 * (migration 20260914090000_settings_privacy_reports_push.sql), granted
 * the same client-update posture as display_name/status_text. Turning
 * this off doesn't stop the underlying read cursor from being written
 * (the owner's own unread-badge accuracy shouldn't depend on whether
 * they share it with others) — it stops thread/[id].tsx from *rendering*
 * a "read" indicator to the other participant. See the migration's
 * header comment. */
export function useSetReadReceiptsEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { userId: string; enabled: boolean }) => {
      const { error } = await supabase
        .from('users')
        .update({ read_receipts_enabled: params.enabled })
        .eq('id', params.userId);
      if (error) throw error;
    },
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ['profile', params.userId] });
    },
  });
}

/** Last-seen privacy toggle — mirrors useSetReadReceiptsEnabled exactly
 * (new `last_seen_enabled` column, same client-writable-grant posture, see
 * 20260917100000_last_seen.sql). Turning this off hides "online"/"last
 * seen HH:MM" from thread partners (thread/[id].tsx's header) — it
 * doesn't stop `last_seen_at` itself from being written, same reasoning
 * read_receipts_enabled's own comment already gives for that column. */
export function useSetLastSeenEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { userId: string; enabled: boolean }) => {
      const { error } = await supabase
        .from('users')
        .update({ last_seen_enabled: params.enabled })
        .eq('id', params.userId);
      if (error) throw error;
    },
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ['profile', params.userId] });
    },
  });
}

/** Reports a user — new `user_reports` table, insert-only-own via RLS
 * (no SECURITY DEFINER function needed; this isn't money, and a
 * `with check (reporter_id = auth.uid())` is all the correctness this
 * write needs). Reports aren't readable back by the app — ops/admin
 * review only, per the migration's header comment. */
export function useReportUser() {
  return useMutation({
    mutationFn: async (params: {
      reporterId: string;
      reportedUserId: string;
      threadId?: string;
      reason: string;
      details?: string;
    }) => {
      const { error } = await supabase.from('user_reports').insert({
        reporter_id: params.reporterId,
        reported_user_id: params.reportedUserId,
        thread_id: params.threadId ?? null,
        reason: params.reason,
        details: params.details ?? null,
      });
      if (error) throw error;
    },
  });
}

export interface AccountDeletionRequest {
  id: string;
  status: 'pending' | 'completed' | 'cancelled';
  created_at: string;
}

/** The caller's own account-deletion request, if any — Settings shows
 * "Request pending" instead of the request button once one exists,
 * rather than letting someone file duplicates. */
export function useAccountDeletionRequest(userId: string | undefined) {
  return useQuery({
    queryKey: ['accountDeletionRequest', userId],
    enabled: !!userId,
    queryFn: async (): Promise<AccountDeletionRequest | null> => {
      const { data, error } = await supabase
        .from('account_deletion_requests')
        .select('id, status, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

/** Files a deletion request for manual review — not instant self-service
 * delete. This app custodies real money; what should actually happen to
 * a wallet balance (force a withdrawal first? hold under a notice
 * period?) is a policy decision per CLAUDE.md's regulatory posture, not
 * something to decide in application code. See the migration's header
 * comment. */
export function useRequestAccountDeletion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { userId: string; reason?: string }) => {
      const { error } = await supabase.from('account_deletion_requests').insert({
        user_id: params.userId,
        reason: params.reason ?? null,
      });
      if (error) throw error;
    },
    onSuccess: (_data, params) => {
      queryClient.invalidateQueries({ queryKey: ['accountDeletionRequest', params.userId] });
    },
  });
}
