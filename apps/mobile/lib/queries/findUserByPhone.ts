import { useMutation } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';

export interface FoundUser {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** Wraps POST /functions/v1/find-user-by-phone — the only way to resolve a
 * phone number to a user id for starting a new chat (direct table reads
 * can't do this; see that function's own header comment for why). */
export function useFindUserByPhone() {
  return useMutation({
    mutationFn: (phone: string) => callEdgeFunction<FoundUser>('find-user-by-phone', { phone }),
  });
}
