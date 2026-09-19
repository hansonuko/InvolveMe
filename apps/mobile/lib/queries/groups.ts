import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { callEdgeFunction, EdgeFunctionError } from '@/lib/edgeFunctions';
import { useRealtimeTableChanges } from '@/lib/realtimeChannel';
import { supabase } from '@/lib/supabase';

export interface GroupThread {
  id: string;
  name: string;
  avatar_url: string | null;
  created_by: string;
  last_message_at: string | null;
  created_at: string;
  /** Resolved client-side below, same "separate query, simpler to read
   * than a PostgREST embed" reasoning useThreads already documents. */
  member_count: number;
  last_message_body: string | null;
}

/** Groups the current user belongs to, newest activity first — `RLS`
 * (`group_threads_select_member`) already scopes this to the caller's own
 * groups, so no explicit membership filter is needed here, same as
 * `useThreads`. Free-messaging era only (docs/03-ECONOMY-LEDGER.md §10) —
 * nothing here is billing-aware because nothing about it costs credits
 * yet. */
export function useGroups(currentUserId: string | undefined) {
  return useQuery({
    queryKey: ['groups', currentUserId],
    enabled: !!currentUserId,
    queryFn: async (): Promise<GroupThread[]> => {
      const { data: groups, error } = await supabase
        .from('group_threads')
        .select('id, name, avatar_url, created_by, last_message_at, created_at')
        .order('last_message_at', { ascending: false, nullsFirst: false });

      if (error) throw error;
      if (!groups?.length) return [];

      const groupIds = groups.map((g) => g.id);

      const { data: memberRows, error: memberError } = await supabase
        .from('group_members')
        .select('group_thread_id')
        .in('group_thread_id', groupIds);
      if (memberError) throw memberError;

      const memberCountByGroupId = new Map<string, number>();
      for (const row of memberRows ?? []) {
        memberCountByGroupId.set(
          row.group_thread_id,
          (memberCountByGroupId.get(row.group_thread_id) ?? 0) + 1,
        );
      }

      const { data: recentMessages, error: messagesError } = await supabase
        .from('group_messages')
        .select('group_thread_id, body, created_at')
        .in('group_thread_id', groupIds)
        .order('created_at', { ascending: false });
      if (messagesError) throw messagesError;

      const lastBodyByGroupId = new Map<string, string>();
      for (const m of recentMessages ?? []) {
        if (!lastBodyByGroupId.has(m.group_thread_id)) {
          lastBodyByGroupId.set(m.group_thread_id, m.body);
        }
      }

      return groups.map((g) => ({
        ...g,
        member_count: memberCountByGroupId.get(g.id) ?? 0,
        last_message_body: lastBodyByGroupId.get(g.id) ?? null,
      }));
    },
  });
}

export interface GroupInfo {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  created_by: string;
  created_at: string;
}

/** A single group's own name/description/avatar/owner — the group-thread
 * screen's header and the group-info screen (punch-list item 2,
 * 2026-09-19) both need this in addition to the member list
 * `useGroupMembers` already provides; kept separate rather than folded
 * into that hook since a header can render (with a loading name) before
 * the member list has resolved. */
export function useGroupInfo(groupThreadId: string | undefined) {
  return useQuery({
    queryKey: ['groupInfo', groupThreadId],
    enabled: !!groupThreadId,
    queryFn: async (): Promise<GroupInfo> => {
      const { data, error } = await supabase
        .from('group_threads')
        .select('id, name, description, avatar_url, created_by, created_at')
        .eq('id', groupThreadId as string)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

export interface GroupMember {
  user_id: string;
  role: 'admin' | 'member';
  display_name: string | null;
  avatar_url: string | null;
}

/** A group's member list, joined with basic profile fields — powers both
 * the group-thread header (member count/list) and message-bubble sender
 * names, since a group has no single "the other participant" the way a
 * 1:1 thread does. */
export function useGroupMembers(groupThreadId: string | undefined) {
  return useQuery({
    queryKey: ['groupMembers', groupThreadId],
    enabled: !!groupThreadId,
    queryFn: async (): Promise<GroupMember[]> => {
      const { data: members, error } = await supabase
        .from('group_members')
        .select('user_id, role')
        .eq('group_thread_id', groupThreadId as string);
      if (error) throw error;
      if (!members?.length) return [];

      const { data: profiles, error: profilesError } = await supabase
        .from('users')
        .select('id, display_name, avatar_url')
        .in(
          'id',
          members.map((m) => m.user_id),
        );
      if (profilesError) throw profilesError;

      const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));

      return members.map((m) => ({
        user_id: m.user_id,
        role: m.role as 'admin' | 'member',
        display_name: profileById.get(m.user_id)?.display_name ?? null,
        avatar_url: profileById.get(m.user_id)?.avatar_url ?? null,
      }));
    },
  });
}

export interface GroupMessage {
  id: string;
  group_thread_id: string;
  sender_id: string;
  body: string;
  word_count: number;
  created_at: string;
  /** Display-only "Forwarded" tag — see Message.is_forwarded's own comment
   * in lib/queries/messages.ts. */
  is_forwarded: boolean;
}

/** Messages in a group, oldest first, kept live via Realtime — same shape
 * `useThreadMessages` already establishes for 1:1 threads. */
export function useGroupMessages(groupThreadId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = ['groupMessages', groupThreadId];

  const query = useQuery({
    queryKey,
    enabled: !!groupThreadId,
    queryFn: async (): Promise<GroupMessage[]> => {
      const { data, error } = await supabase
        .from('group_messages')
        .select('id, group_thread_id, sender_id, body, word_count, created_at, is_forwarded')
        .eq('group_thread_id', groupThreadId as string)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
  });

  useRealtimeTableChanges(
    groupThreadId ? `group-messages:${groupThreadId}` : undefined,
    {
      event: 'INSERT',
      schema: 'public',
      table: 'group_messages',
      filter: `group_thread_id=eq.${groupThreadId}`,
    },
    () => {
      queryClient.invalidateQueries({ queryKey });
    },
  );

  return query;
}

interface CreateGroupRequest {
  name: string;
  memberIds: string[];
}

interface CreateGroupResponse {
  group_thread_id: string;
}

/** Wraps POST /functions/v1/create-group-thread. */
export function useCreateGroup() {
  const queryClient = useQueryClient();

  return useMutation<CreateGroupResponse, EdgeFunctionError, CreateGroupRequest>({
    mutationFn: (request) =>
      callEdgeFunction<CreateGroupResponse>('create-group-thread', {
        name: request.name,
        member_ids: request.memberIds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

interface SendGroupMessageRequest {
  groupThreadId: string;
  body: string;
  /** Offline outbox replay key — see SendMessageRequest's identical field
   * in lib/queries/messages.ts for the full rationale. */
  clientMessageId?: string;
  /** Display-only "Forwarded" tag — see Message.is_forwarded's own comment
   * in lib/queries/messages.ts. */
  isForwarded?: boolean;
}

interface SendGroupMessageResponse {
  message_id: string;
  word_count: number;
  created_at: string;
}

/** Wraps POST /functions/v1/send-group-message — always free (see that
 * function's own header comment for why). No `EdgeFunctionError.details`
 * consumer needed the way `useSendMessage` has for insufficient-credit,
 * since a free send has no credit outcome to branch on. */
export function useSendGroupMessage() {
  const queryClient = useQueryClient();

  return useMutation<SendGroupMessageResponse, EdgeFunctionError, SendGroupMessageRequest>({
    mutationFn: (request) =>
      callEdgeFunction<SendGroupMessageResponse>('send-group-message', {
        group_thread_id: request.groupThreadId,
        body: request.body,
        client_message_id: request.clientMessageId,
        is_forwarded: request.isForwarded,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['groupMessages', variables.groupThreadId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

// =============================================================================
// Group admin actions (punch-list item 2, 2026-09-19) — add/remove members,
// promote/demote admin, leave, and edit name/description/avatar. Each
// wraps a SECURITY DEFINER Postgres function via its own Edge Function
// (migration 20260919120000_group_admin_actions.sql), same "no financial
// or membership logic in the client" posture every other mutation in this
// file already follows — these functions just forward + invalidate.
// =============================================================================

interface AddGroupMembersRequest {
  groupThreadId: string;
  memberIds: string[];
}

/** Wraps POST /functions/v1/add-group-members — any current member can add
 * more (see that Edge Function's own header comment on matching
 * WhatsApp's default permission model), not just admins. */
export function useAddGroupMembers() {
  const queryClient = useQueryClient();

  return useMutation<{ added_count: number }, EdgeFunctionError, AddGroupMembersRequest>({
    mutationFn: (request) =>
      callEdgeFunction('add-group-members', {
        group_thread_id: request.groupThreadId,
        member_ids: request.memberIds,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['groupMembers', variables.groupThreadId] });
      queryClient.invalidateQueries({ queryKey: ['groupInfo', variables.groupThreadId] });
    },
  });
}

interface RemoveGroupMemberRequest {
  groupThreadId: string;
  targetUserId: string;
}

/** Wraps POST /functions/v1/remove-group-member — admin-only; the group
 * owner can never be targeted (rejected server-side either way). */
export function useRemoveGroupMember() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, RemoveGroupMemberRequest>({
    mutationFn: (request) =>
      callEdgeFunction('remove-group-member', {
        group_thread_id: request.groupThreadId,
        target_user_id: request.targetUserId,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['groupMembers', variables.groupThreadId] });
    },
  });
}

/** Wraps POST /functions/v1/leave-group — self-service; the group owner is
 * blocked server-side (no ownership-transfer path yet). */
export function useLeaveGroup() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, { groupThreadId: string }>({
    mutationFn: (request) =>
      callEdgeFunction('leave-group', { group_thread_id: request.groupThreadId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

interface SetGroupMemberRoleRequest {
  groupThreadId: string;
  targetUserId: string;
  role: 'admin' | 'member';
}

/** Wraps POST /functions/v1/set-group-member-role — promote/demote,
 * admin-only; the owner's own role can never change. */
export function useSetGroupMemberRole() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, SetGroupMemberRoleRequest>({
    mutationFn: (request) =>
      callEdgeFunction('set-group-member-role', {
        group_thread_id: request.groupThreadId,
        target_user_id: request.targetUserId,
        role: request.role,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['groupMembers', variables.groupThreadId] });
    },
  });
}

interface UpdateGroupProfileRequest {
  groupThreadId: string;
  /** Each field is independently optional — omit to leave it unchanged.
   * An empty string on `description` clears it (distinct from omitting
   * it), same contract fn_update_group_profile documents. */
  name?: string;
  description?: string;
  avatarUrl?: string;
}

/** Wraps POST /functions/v1/update-group-profile — admin-only rename/
 * description/avatar update. */
export function useUpdateGroupProfile() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: true }, EdgeFunctionError, UpdateGroupProfileRequest>({
    mutationFn: (request) =>
      callEdgeFunction('update-group-profile', {
        group_thread_id: request.groupThreadId,
        name: request.name,
        description: request.description,
        avatar_url: request.avatarUrl,
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['groupInfo', variables.groupThreadId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}

interface CreateGroupAvatarUploadUrlResponse {
  path: string;
  token: string;
  signed_url: string;
  /** Already cache-busted (a `?t=` query param) — write this straight onto
   * the group via useUpdateGroupProfile once the upload itself succeeds,
   * same shape useCreateProfileUploadUrl's own response documents. */
  public_url: string;
}

/** Wraps POST /functions/v1/create-group-avatar-upload-url — mints a
 * signed upload slot in the public `profile-media` bucket for a group's
 * photo, at `groups/${groupThreadId}.jpg`. Admin-only (checked server-side
 * against the caller's own membership row, not trusted from the client). */
export function useCreateGroupAvatarUploadUrl() {
  return useMutation<CreateGroupAvatarUploadUrlResponse, EdgeFunctionError, string>({
    mutationFn: (groupThreadId) =>
      callEdgeFunction('create-group-avatar-upload-url', { group_thread_id: groupThreadId }),
  });
}
