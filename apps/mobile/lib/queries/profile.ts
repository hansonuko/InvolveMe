import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';

export interface ProfileLink {
  label: string;
  url: string;
}

export interface Profile {
  display_name: string | null;
  status_text: string | null;
  phone: string | null;
  read_receipts_enabled: boolean;
  last_seen_enabled: boolean;
  avatar_url: string | null;
  cover_url: string | null;
  links: ProfileLink[];
  /** Whether two-step verification is currently on — never the PIN hash
   * itself, which this app's own column grant (20260918110000_profile_
   * media_and_two_step.sql) doesn't even let the client update, let alone
   * read back meaningfully. */
  two_step_enabled: boolean;
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
        .select(
          'display_name, status_text, phone, read_receipts_enabled, last_seen_enabled, avatar_url, cover_url, links, two_step_enabled',
        )
        .eq('id', userId)
        .single();
      if (error) throw error;
      return { ...data, links: (data.links ?? []) as ProfileLink[] };
    },
  });
}

export interface PublicProfile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  status_text: string | null;
  links: ProfileLink[];
  /** E.164 digits, no leading `+` (docs/02-DATA-MODEL.md storage
   * convention) — shown on the profile screen the same way
   * thread/[id].tsx's header already surfaces a partner's phone
   * (`ThreadHeaderInfo.partnerPhone`), so this isn't a new exposure, just
   * the same field reused here. */
  phone: string | null;
}

/** Another user's read-only public profile fields — for the profile screen
 * reached from a chat-row avatar tap or the thread header. Wider than the
 * original minimal version (adds cover_url/links/phone) to support full
 * WhatsApp-style contact-info parity, but still deliberately excludes
 * anything privacy-gated or account-internal (read_receipts_enabled,
 * last_seen_*, two_step_*) — those stay on `useProfile`/`useThreadHeaderInfo`,
 * which already apply the right gating for their own contexts. */
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
        .select('id, display_name, avatar_url, cover_url, status_text, links, phone')
        .eq('id', userId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return { ...data, links: (data.links ?? []) as ProfileLink[] };
    },
  });
}

/** Updates the caller's own display_name/status_text/avatar_url/cover_url/
 * links — all client-updatable per the RLS grant in
 * 20260912072749_rls_policies.sql + 20260918110000_profile_media_and_two_
 * step.sql (which widened it to add cover_url/links). Avatar/cover here
 * take an already-uploaded public URL (from create-profile-upload-url +
 * uploadProfileMedia, see lib/queries/profileMedia.ts) — this mutation
 * itself does no uploading, just the same plain field write every other
 * profile field already goes through. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      userId: string;
      displayName?: string;
      statusText?: string;
      avatarUrl?: string;
      coverUrl?: string;
      links?: ProfileLink[];
    }) => {
      const update: Record<string, unknown> = {};
      if (params.displayName !== undefined) update.display_name = params.displayName;
      if (params.statusText !== undefined) update.status_text = params.statusText;
      if (params.avatarUrl !== undefined) update.avatar_url = params.avatarUrl;
      if (params.coverUrl !== undefined) update.cover_url = params.coverUrl;
      if (params.links !== undefined) update.links = params.links;

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
