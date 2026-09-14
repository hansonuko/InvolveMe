import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { hasRegisteredPushToken, registerPushToken, unregisterPushToken } from '@/lib/push';

/** Whether this device currently has a registered push token — "off" has
 * no dedicated column (see supabase/functions/_shared/push.ts), so this
 * is the actual source of truth the Settings toggle reflects, not a
 * separate preference that could drift out of sync with it. */
export function usePushEnabled(userId: string | undefined) {
  return useQuery({
    queryKey: ['pushEnabled', userId],
    enabled: !!userId,
    queryFn: () => hasRegisteredPushToken(userId!),
  });
}

/** Turning this on requests OS notification permission (a real prompt,
 * not assumed granted) and registers this device's token; turning it off
 * deletes the token. Returns the actual resulting state so the caller
 * can show "permission denied" distinctly from "turned off" — a denied
 * permission needs a trip to OS Settings, a toggle-off doesn't. */
export function useSetPushEnabled() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { userId: string; enabled: boolean }) => {
      if (params.enabled) {
        return registerPushToken(params.userId);
      }
      await unregisterPushToken();
      return 'granted' as const; // "off" always succeeds; no permission state to report
    },
    onSuccess: (_result, params) => {
      queryClient.invalidateQueries({ queryKey: ['pushEnabled', params.userId] });
    },
  });
}
