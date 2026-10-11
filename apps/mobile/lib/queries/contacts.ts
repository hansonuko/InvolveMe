import { useMutation, useQuery } from '@tanstack/react-query';

import { callEdgeFunction } from '@/lib/edgeFunctions';
import { supabase } from '@/lib/supabase';

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

export interface SavedContactNameRow {
  owner_user_id: string;
  contact_user_id: string;
  name: string;
}

/** Writes this device's locally-saved names for already-matched InvolveMe
 * contacts (session 45 continued) — so a name saved on one device shows
 * the same way everywhere else the same account is used, not just on the
 * phone it was saved on. Scoped to matched users only, never every device
 * contact — a real product/privacy decision, not a shortcut (see
 * `supabase/migrations/20261010090000_saved_contact_names.sql`'s own
 * header). A direct authenticated upsert, not an Edge Function: RLS
 * (`owner_user_id = auth.uid()`) is the entire enforcement this needs, and
 * every `contact_user_id` here was already legitimately returned to this
 * same caller by `find-users-by-phones` moments earlier — nothing this
 * writes discloses anything the caller didn't already have. */
export function useSyncContactNames() {
  return useMutation({
    mutationFn: async (rows: Pick<SavedContactNameRow, 'contact_user_id' | 'name'>[]) => {
      if (rows.length === 0) return;
      const { data: auth } = await supabase.auth.getUser();
      const ownerUserId = auth.user?.id;
      if (!ownerUserId) return;

      const { error } = await supabase.from('saved_contact_names').upsert(
        rows.map((r) => ({
          owner_user_id: ownerUserId,
          ...r,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: 'owner_user_id,contact_user_id' },
      );
      if (error) throw error;
    },
  });
}

/** Reads back every name the current user has saved for a matched
 * InvolveMe contact, from whichever device originally synced it — the
 * read half of `useSyncContactNames` above. `lib/contacts.ts`'s
 * `usePhoneContactNames`/`resolveContactName` is the one place this
 * actually gets consumed, merged with (and losing priority to) this
 * device's own live `expo-contacts` result.
 *
 * Returns a plain array, not a `Map` — a real crash found live (session
 * 45 continued) the first time this went through a real reload:
 * `PersistQueryClientProvider` JSON-serializes the whole query cache to
 * `AsyncStorage`, and `JSON.stringify(new Map(...))` silently collapses
 * to `{}`, discarding every entry. The *restored* value on next load is
 * then a plain object with no `.get` — not `null`/`undefined`, so the
 * optional chaining at every call site didn't save it, it just threw
 * ".get is not a function" the instant anything called it. Build the
 * actual `Map` only client-side, from this plain data, never store one in
 * a persisted query's result. */
export function useSavedContactNames(userId: string | undefined) {
  return useQuery({
    queryKey: ['savedContactNames', userId],
    enabled: !!userId,
    queryFn: async (): Promise<SavedContactNameRow[]> => {
      const { data, error } = await supabase
        .from('saved_contact_names')
        .select('owner_user_id, contact_user_id, name')
        .eq('owner_user_id', userId);
      if (error) throw error;
      return data ?? [];
    },
  });
}
