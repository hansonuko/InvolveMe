import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { type DeviceContact, useDeviceContacts } from '@/lib/contacts';
import { type MatchedContactUser, useFindUsersByPhones } from '@/lib/queries/contacts';
import { useFindUserByPhone } from '@/lib/queries/findUserByPhone';
import { toE164NigerianPhone } from '@/lib/phone';
import { useTheme } from '@/theme';

const SEARCH_DEBOUNCE_MS = 350;
// Defensive cap on how many locally-filtered device contacts get sent to
// find-users-by-phones per search — a name/number query realistically
// narrows a phonebook to a handful of people, this just bounds the
// pathological case (e.g. searching a single common letter) well under
// that function's own MAX_PHONES_PER_CALL (2000).
const SEARCH_MAX_LOCAL_MATCHES = 30;
const SEARCH_MIN_PHONE_DIGITS = 10;

interface MemberSearchListProps {
  /** Gates the debounce effect the same way a modal's own `visible` prop
   * would — pass the parent modal's visibility straight through. */
  visible: boolean;
  /** Already-selected or already-a-member ids — filtered out of results so
   * someone can't be picked twice. */
  excludeUserIds: Set<string>;
  onSelect: (user: MatchedContactUser) => void;
}

/** WhatsApp-standard "search-as-you-type" member picker (punch-list item 1,
 * 2026-09-19, extracted as a shared component for item 2's "add members to
 * an existing group" flow, 2026-09-19): nothing loads automatically. The
 * device phonebook is read lazily on the first keystroke, cached, and
 * filtered locally after that; only a small, already-narrowed candidate
 * set gets verified against InvolveMe per (debounced) search. A typed
 * number that looks complete is also resolved directly via
 * find-user-by-phone in parallel, so the same box finds a saved contact
 * *and* looks up someone who isn't saved as one at all.
 *
 * Deliberately excludes the "selected members" chips row and the final
 * confirm/create button — those differ per caller (NewGroupModal has a
 * group-name field and a "Create group" button; the in-group add-members
 * flow has neither) — this component is just the search box + result list
 * unit both reuse.
 *
 * Has no reset prop: a caller that needs to clear this component's
 * internal state (e.g. a modal closing) should remount it with a changing
 * `key` instead of threading a reset signal through a prop — simpler, and
 * it resets every piece of state (including the cached device-contacts
 * read) correctly by construction rather than needing its own
 * synchronize-to-a-prop effect. */
export function MemberSearchList({ visible, excludeUserIds, onSelect }: MemberSearchListProps) {
  const { colors, spacing, radius } = useTheme();
  const { status, error, sync } = useDeviceContacts();
  const findUsers = useFindUsersByPhones();
  const findUserByPhone = useFindUserByPhone();

  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<MatchedContactUser[]>([]);
  const [phoneMatch, setPhoneMatch] = useState<MatchedContactUser | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Lazily populated on the first non-empty search — never on mount.
  // `null` means "not read yet," `[]` means "read, empty/denied."
  const [deviceContacts, setDeviceContacts] = useState<DeviceContact[] | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!visible) return;
    const query = search.trim();
    if (!query) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setSearching(true);
        setSearchError(null);
        try {
          let contacts = deviceContacts;
          if (contacts === null) {
            contacts = await sync();
            if (cancelled) return;
            setDeviceContacts(contacts);
          }

          const lowerQuery = query.toLowerCase();
          const digitsQuery = query.replace(/\D/g, '');

          const localMatches = contacts
            .filter((c) => {
              const nameHit = c.name?.toLowerCase().includes(lowerQuery) ?? false;
              const phoneHit =
                digitsQuery.length >= 3 &&
                c.phones.some((p) => p.replace(/\D/g, '').includes(digitsQuery));
              return nameHit || phoneHit;
            })
            .slice(0, SEARCH_MAX_LOCAL_MATCHES);

          if (localMatches.length > 0) {
            const phoneToContactName = new Map<string, string>();
            const candidatePhones: string[] = [];
            for (const c of localMatches) {
              for (const p of c.phones) {
                const e164 = toE164NigerianPhone(p);
                if (c.name) phoneToContactName.set(e164.replace(/^\+/, ''), c.name);
                candidatePhones.push(e164);
              }
            }
            const result = await findUsers.mutateAsync([...new Set(candidatePhones)]);
            if (cancelled) return;
            setSearchResults(
              result.matches.map((m) => ({
                ...m,
                display_name: phoneToContactName.get(m.phone) ?? m.display_name,
              })),
            );
          } else {
            setSearchResults([]);
          }

          // The typed text itself looks like a full phone number — resolve
          // it directly too, independent of whatever's saved on-device, so
          // someone not in the phonebook at all can still be found.
          if (digitsQuery.length >= SEARCH_MIN_PHONE_DIGITS) {
            try {
              const normalized = toE164NigerianPhone(query);
              const found = await findUserByPhone.mutateAsync(normalized);
              if (!cancelled) {
                setPhoneMatch({ ...found, phone: normalized.replace(/^\+/, '') });
              }
            } catch {
              if (!cancelled) setPhoneMatch(null);
            }
          } else {
            setPhoneMatch(null);
          }
        } catch (e) {
          if (!cancelled) {
            setSearchError(e instanceof Error ? e.message : 'Search failed.');
          }
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, visible, retryKey]);

  const handleSelect = (user: MatchedContactUser) => {
    onSelect(user);
    setSearch('');
    setSearchResults([]);
    setPhoneMatch(null);
  };

  const visibleResults = searchResults.filter((r) => !excludeUserIds.has(r.id));
  const showPhoneMatch =
    !!phoneMatch &&
    !excludeUserIds.has(phoneMatch.id) &&
    !visibleResults.some((r) => r.id === phoneMatch.id);

  return (
    <>
      <TextInput
        value={search}
        onChangeText={(text) => {
          setSearch(text);
          if (!text.trim()) {
            setSearchResults([]);
            setPhoneMatch(null);
            setSearchError(null);
          }
        }}
        placeholder="Search name or phone number"
        placeholderTextColor={colors.textSecondary}
        style={[
          searchStyles.input,
          {
            backgroundColor: colors.bgSurfaceAlt,
            color: colors.textPrimary,
            borderRadius: radius.card,
            borderColor: colors.borderSubtle,
          },
        ]}
      />

      {!search.trim() ? (
        <View style={searchStyles.empty}>
          <Text variant="body" color="tertiary" style={{ textAlign: 'center' }}>
            Type a name or phone number to add members.
          </Text>
          {status === 'denied' ? (
            <>
              <Text
                variant="caption"
                color="tertiary"
                style={{ textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.md }}
              >
                Contacts access is off — you can still add someone by their phone number.
              </Text>
              <Button label="Open settings" onPress={() => void Linking.openSettings()} />
            </>
          ) : status === 'error' ? (
            <Text
              variant="caption"
              color="danger"
              style={{ textAlign: 'center', marginTop: spacing.sm }}
            >
              {error} You can still add someone by their phone number.
            </Text>
          ) : null}
        </View>
      ) : searching ? (
        <View style={searchStyles.empty}>
          <Text variant="body" color="tertiary">
            Searching…
          </Text>
        </View>
      ) : searchError ? (
        <View style={searchStyles.empty}>
          <Text
            variant="body"
            color="danger"
            style={{ textAlign: 'center', marginBottom: spacing.md }}
          >
            Couldn&apos;t search. {searchError}
          </Text>
          <Button label="Retry" onPress={() => setRetryKey((k) => k + 1)} />
        </View>
      ) : visibleResults.length === 0 && !showPhoneMatch ? (
        <View style={searchStyles.empty}>
          <Text variant="body" color="tertiary" style={{ textAlign: 'center' }}>
            No matches on InvolveMe yet.
          </Text>
        </View>
      ) : (
        <FlatList
          data={visibleResults}
          keyExtractor={(u) => u.id}
          style={{ flex: 1 }}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => handleSelect(item)}
              style={({ pressed }) => [
                searchStyles.row,
                {
                  paddingVertical: spacing.sm,
                  backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
                },
              ]}
            >
              <Avatar uri={item.avatar_url} displayName={item.display_name} size={44} />
              <Text variant="bodyMedium" style={{ flex: 1, marginLeft: spacing.md }}>
                {item.display_name ?? 'Unnamed'}
              </Text>
              <Ionicons name="add-circle-outline" size={22} color={colors.brandPrimary} />
            </Pressable>
          )}
          ListFooterComponent={
            showPhoneMatch && phoneMatch ? (
              <Pressable
                onPress={() => handleSelect(phoneMatch)}
                style={({ pressed }) => [
                  searchStyles.row,
                  {
                    paddingVertical: spacing.sm,
                    backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
                  },
                ]}
              >
                <Avatar
                  uri={phoneMatch.avatar_url}
                  displayName={phoneMatch.display_name}
                  size={44}
                />
                <Text variant="bodyMedium" style={{ flex: 1, marginLeft: spacing.md }}>
                  {phoneMatch.display_name ?? 'Unnamed'}
                </Text>
                <Ionicons name="add-circle-outline" size={22} color={colors.brandPrimary} />
              </Pressable>
            ) : null
          }
        />
      )}
    </>
  );
}

const searchStyles = StyleSheet.create({
  input: { borderWidth: 1, paddingHorizontal: 16, paddingVertical: 14, fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'center' },
  empty: { paddingTop: 48, alignItems: 'center' },
});
