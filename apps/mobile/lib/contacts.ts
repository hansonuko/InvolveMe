import { Contact, ContactField, requestPermissionsAsync } from 'expo-contacts';
import { useCallback, useEffect, useState } from 'react';

import { withAppLockSuppressed } from '@/lib/appLock';
import { useContactsChangedStore } from '@/lib/contactsChangedStore';
import { toE164NigerianPhone } from '@/lib/phone';

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
 */
export function usePhoneContactNames() {
  const { sync } = useDeviceContacts();
  const [phoneToContactName, setPhoneToContactName] = useState<Map<string, string>>(new Map());
  const contactsVersion = useContactsChangedStore((s) => s.version);

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
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactsVersion]);

  const resolveContactName = useCallback(
    (partner: { display_name: string | null; phone: string | null }): string => {
      if (partner.phone) {
        const contactName = phoneToContactName.get(partner.phone);
        if (contactName) return contactName;
        return `+${partner.phone}`;
      }
      return partner.display_name ?? 'Unnamed';
    },
    [phoneToContactName],
  );

  return { phoneToContactName, resolveContactName };
}
