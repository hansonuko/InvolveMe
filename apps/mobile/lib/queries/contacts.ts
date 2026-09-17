import { useMutation } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';

export interface MatchedContactUser {
  phone: string;
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

interface FindUsersByPhonesResponse {
  matches: MatchedContactUser[];
}

/** Wraps POST /functions/v1/find-users-by-phones — batch phone lookup for
 * the device-contacts sync flow (docs/10-UX-REFINEMENT-BACKLOG.md Batch
 * C1). See lib/contacts.ts's useDeviceContacts for the device-side half. */
export function useFindUsersByPhones() {
  return useMutation({
    mutationFn: (phones: string[]) =>
      callEdgeFunction<FindUsersByPhonesResponse>('find-users-by-phones', { phones }),
  });
}
