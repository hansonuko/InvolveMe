import { Contact, ContactField, requestPermissionsAsync } from 'expo-contacts';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { withAppLockSuppressed } from '@/lib/appLock';
import { useContactsChangedStore } from '@/lib/contactsChangedStore';
import { useSession } from '@/lib/hooks/useSession';
import { toE164NigerianPhone } from '@/lib/phone';
import {
  useFindUsersByPhones,
  useSavedContactNames,
  useSyncContactNames,
} from '@/lib/queries/contacts';

export interface DeviceContact {
  id: string;
  name: string | null;
  phones: string[];
}

export type ContactsSyncStatus = 'idle' | 'requesting' | 'denied' | 'loading' | 'ready' | 'error';

const CONTACT_FIELDS = [ContactField.FULL_NAME, ContactField.PHONES] as const;

/**
 * Reads the device's contact list, gated behind its own permission prompt
 * requested on first use of the Contacts tab (docs/10-UX-REFINEMENT-BACKLOG.md
 * Batch C1) — never on app launch, per the platform-best-practice "ask in
 * context, not at cold-open" rule. Not a TanStack Query hook: this reads
 * local device state behind an OS permission dialog, not server data —
 * same reasoning lib/lastSeen.ts already documents for its own
 * plain-hook-over-TanStack-Query choice.
 *
 * Uses expo-contacts' `Contact.getAllDetails` bulk-fetch API, not the
 * classic `getContactsAsync` — this app's installed expo-contacts version
 * (57.x) throws at runtime on that function; it's kept only as a
 * deprecated compatibility shim pointing at `expo-contacts/legacy`.
 */
export function useDeviceContacts() {
  const [status, setStatus] = useState<ContactsSyncStatus>('idle');
  const [contacts, setContacts] = useState<DeviceContact[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Returns the freshly fetched list directly, not just via the `contacts`
  // state, so a caller chaining into another async step (e.g. the batch
  // phone lookup) doesn't read a stale closure from before this render's
  // state update has actually landed.
  const sync = useCallback(async (): Promise<DeviceContact[]> => {
    setStatus('requesting');
    setError(null);

    // The OS permission dialog itself can fully background this app on
    // Android (a separate system UI, not an in-process overlay) — without
    // this bracket, its own dismissal was tripping useAppLock's re-lock
    // check, which then unmounted the navigator and bounced the user back
    // to the chat list (see lib/appLock.ts's header comment).
    const permission = await withAppLockSuppressed(() => requestPermissionsAsync());
    if (!permission.granted) {
      setStatus('denied');
      return [];
    }

    setStatus('loading');
    try {
      const details = await Contact.getAllDetails(CONTACT_FIELDS);

      const withPhones: DeviceContact[] = details
        .filter((c) => c.phones && c.phones.length > 0)
        .map((c) => ({
          id: c.id,
          name: c.fullName ?? null,
          phones: c.phones.map((p) => p.number).filter((n): n is string => !!n),
        }));

      setContacts(withPhones);
      setStatus('ready');
      return withPhones;
    } catch (e) {
      console.error('useDeviceContacts: Contact.getAllDetails failed:', e);
      setError('Could not read your contacts.');
      setStatus('error');
      return [];
    }
  }, []);

  return { status, contacts, error, sync };
}

/**
 * The one shared "what name do we show for this phone number" rule
 * (originally built inline in `chats.tsx` for punch-list item 1,
 * 2026-09-19; extracted so `thread/[id].tsx`'s header and
 * `profile/[id].tsx` can apply the exact same WhatsApp-standard
 * priority instead of each re-deriving it slightly differently):
 * device-saved contact name first, then the raw phone number —
 * deliberately never this person's own self-chosen `display_name` as
 * the fallback for an unsaved contact, since a self-chosen name is
 * exactly what a bad-faith contact could use to impersonate someone
 * trusted.
 *
 * Syncs device contacts once per mount and again whenever
 * `useContactsChangedStore` bumps (a contact was just saved from
 * `profile/[id].tsx`'s "Save to contacts" action) — every screen using
 * this hook picks up a freshly saved name without needing its own
 * restart or manual refresh.
 *
 * Priority extended (session 45 continued) to fix a real cross-device gap:
 * a name saved on one device only ever showed on that same device — web
 * has no bulk-contacts API at all (always empty here), and a second
 * native device never had that contact saved locally either. Now checks
 * `useSavedContactNames` (`lib/queries/contacts.ts`) — this device's own
 * live `expo-contacts` result still wins when both exist (it's always at
 * least as fresh as whatever was last synced to the server), but the
 * server-saved name is a real fallback now instead of a bare phone number.
 *
 * Also now the one real place `useSyncContactNames` (the *write* side)
 * gets called from — found live that it was wired only into `chats.tsx`'s
 * `ContactsList`, whose own mount effect only ever runs if someone
 * actually visits the Contacts sub-tab specifically, which nobody had
 * (zero rows in `saved_contact_names`, ever, confirmed directly against
 * the dev DB). This hook already reads the full device phonebook on every
 * mount regardless (chats/thread/profile all call it) — uploading matched
 * names from here too, gated to once per JS session via the module-level
 * flag below, actually gets this feature to run without needing a second,
 * easy-to-never-find entry point.
 */
let hasSyncedContactNamesThisSession = false;

export function usePhoneContactNames() {
  const { sync } = useDeviceContacts();
  const [phoneToContactName, setPhoneToContactName] = useState<Map<string, string>>(new Map());
  const contactsVersion = useContactsChangedStore((s) => s.version);
  const { session } = useSession();
  const { data: savedContactNameRows } = useSavedContactNames(session?.user.id);
  const findUsers = useFindUsersByPhones();
  const syncContactNames = useSyncContactNames();
  // Built here, client-side only — never store a `Map` as a persisted
  // query's own result (see useSavedContactNames's header comment for the
  // real crash that caused).
  const savedContactNames = useMemo(
    () => new Map((savedContactNameRows ?? []).map((r) => [r.contact_user_id, r.name])),
    [savedContactNameRows],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const deviceContacts = await sync();
      if (cancelled) return;
      const map = new Map<string, string>();
      for (const c of deviceContacts) {
        if (!c.name) continue;
        for (const p of c.phones) {
          map.set(toE164NigerianPhone(p).replace(/^\+/, ''), c.name);
        }
      }
      setPhoneToContactName(map);

      if (hasSyncedContactNamesThisSession || map.size === 0) return;
      hasSyncedContactNamesThisSession = true;
      try {
        const { matches } = await findUsers.mutateAsync([...map.keys()].map((p) => `+${p}`));
        if (cancelled || matches.length === 0) return;
        const rows = matches
          .map((m) => {
            const name = map.get(m.phone);
            return name ? { contact_user_id: m.id, name } : null;
          })
          .filter((r): r is { contact_user_id: string; name: string } => r !== null);
        if (rows.length > 0) syncContactNames.mutate(rows);
      } catch (e) {
        // A transient failure here just means next session's sync tries
        // again (the flag only guards against re-trying *within* this
        // one) — never worth surfacing to the user over.
        hasSyncedContactNamesThisSession = false;
        console.error('usePhoneContactNames: contact-name sync failed:', e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactsVersion]);

  const resolveContactName = useCallback(
    (partner: { id: string; display_name: string | null; phone: string | null }): string => {
      if (partner.phone) {
        const contactName = phoneToContactName.get(partner.phone);
        if (contactName) return contactName;
        const savedName = savedContactNames?.get(partner.id);
        if (savedName) return savedName;
        return `+${partner.phone}`;
      }
      return partner.display_name ?? 'Unnamed';
    },
    [phoneToContactName, savedContactNames],
  );

  return { phoneToContactName, resolveContactName };
}
