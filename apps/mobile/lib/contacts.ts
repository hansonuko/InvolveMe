import { Contact, ContactField, requestPermissionsAsync } from 'expo-contacts';
import { useCallback, useState } from 'react';

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

    const permission = await requestPermissionsAsync();
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
