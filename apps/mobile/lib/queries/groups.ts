import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { callEdgeFunction, EdgeFunctionError } from '@/lib/edgeFunctions';
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
  avatar_url: string | null;
  created_by: string;
}

/** A single group's own name/avatar/owner — the group-thread screen's
 * header needs this in addition to the member list `useGroupMembers`
 * already provides; kept separate rather than folded into that hook since
 * a header can render (with a loading name) before the member list has
 * resolved. */
export function useGroupInfo(groupThreadId: string | undefined) {
  return useQuery({
    queryKey: ['groupInfo', groupThreadId],
    enabled: !!groupThreadId,
    queryFn: async (): Promise<GroupInfo> => {
      const { data, error } = await supabase
        .from('group_threads')
        .select('id, name, avatar_url, created_by')
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
        .select('id, group_thread_id, sender_id, body, word_count, created_at')
        .eq('group_thread_id', groupThreadId as string)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!groupThreadId) return;

    const channel = supabase
      .channel(`group-messages:${groupThreadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'group_messages',
          filter: `group_thread_id=eq.${groupThreadId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupThreadId]);

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
      }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['groupMessages', variables.groupThreadId] });
      queryClient.invalidateQueries({ queryKey: ['groups'] });
    },
  });
}
