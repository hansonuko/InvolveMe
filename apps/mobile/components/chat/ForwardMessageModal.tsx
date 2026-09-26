import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, TextInput, View } from 'react-native';

import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Text } from '@/components/ui/Text';
import { usePhoneContactNames } from '@/lib/contacts';
import { useGroups } from '@/lib/queries/groups';
import { useThreads } from '@/lib/queries/threads';
import { useTheme } from '@/theme';

export interface ForwardTarget {
  kind: '1:1' | 'group';
  id: string;
  name: string;
  avatarUrl: string | null;
  /** docs/21-E2EE-TECHNICAL-DESIGN.md §6 — only ever set for a `'1:1'`
   * target (group chat has no e2ee support at all, out of scope
   * entirely). `useSendMessage` needs this and `partnerId` below to
   * encrypt a forward instead of sending it as plaintext when the target
   * thread is e2ee-active. */
  e2eeStatus?: 'off' | 'active';
  /** The target thread's other participant — same reasoning as
   * `e2eeStatus`, only meaningful for a `'1:1'` target. */
  partnerId?: string;
}

interface ForwardMessageModalProps {
  visible: boolean;
  onClose: () => void;
  currentUserId: string | undefined;
  /** How many messages are being forwarded — drives the header text and
   * the confirm button's label, same "N selected" convention the thread
   * screen's own multi-select toolbar already uses. */
  messageCount: number;
  onConfirm: (targets: ForwardTarget[]) => void;
  sending: boolean;
}

/** WhatsApp's own "Forward to" picker: a searchable list of existing
 * conversations (1:1 threads and groups, both — WhatsApp forwards to
 * either), multi-select via a checkmark circle matching the thread
 * screen's own multi-select visual language, one "Forward" action sends
 * the message(s) to every picked target. Deliberately reuses `useThreads`/
 * `useGroups` (the same data the Chats/Groups tabs already show) rather
 * than a bespoke query — a forward target is exactly "a conversation I
 * already have," never a fresh contact search (that's what starting a new
 * chat is for). */
export function ForwardMessageModal({
  visible,
  onClose,
  currentUserId,
  messageCount,
  onConfirm,
  sending,
}: ForwardMessageModalProps) {
  const { colors, spacing, radius } = useTheme();
  const { data: threads } = useThreads(currentUserId);
  const { data: groups } = useGroups(currentUserId);
  const { resolveContactName } = usePhoneContactNames();

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Map<string, ForwardTarget>>(new Map());

  const targets: ForwardTarget[] = useMemo(() => {
    const threadTargets: ForwardTarget[] = (threads ?? []).map((t) => ({
      kind: '1:1',
      id: t.id,
      name: resolveContactName(t.partner),
      avatarUrl: t.partner.avatar_url,
      e2eeStatus: t.e2ee_status,
      partnerId: t.partner.id,
    }));
    const groupTargets: ForwardTarget[] = (groups ?? []).map((g) => ({
      kind: 'group',
      id: g.id,
      name: g.name,
      avatarUrl: g.avatar_url,
    }));
    const combined = [...threadTargets, ...groupTargets];
    const query = search.trim().toLowerCase();
    return query ? combined.filter((t) => t.name.toLowerCase().includes(query)) : combined;
  }, [threads, groups, resolveContactName, search]);

  const toggle = (target: ForwardTarget) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const key = `${target.kind}:${target.id}`;
      if (next.has(key)) next.delete(key);
      else next.set(key, target);
      return next;
    });
  };

  const handleClose = () => {
    setSearch('');
    setSelected(new Map());
    onClose();
  };

  const handleConfirm = () => {
    if (selected.size === 0) return;
    onConfirm([...selected.values()]);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleClose}>
      <Screen>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingBottom: spacing.md,
          }}
        >
          <Pressable onPress={handleClose} hitSlop={12}>
            <Ionicons name="close" size={24} color={colors.textSecondary} />
          </Pressable>
          <Text variant="bodyMedium">
            Forward {messageCount} message{messageCount > 1 ? 's' : ''}
          </Text>
          <View style={{ width: 24 }} />
        </View>

        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search chats and groups"
          placeholderTextColor={colors.textSecondary}
          style={{
            borderWidth: 1,
            borderColor: colors.borderSubtle,
            backgroundColor: colors.bgSurfaceAlt,
            color: colors.textPrimary,
            borderRadius: radius.card,
            paddingHorizontal: 16,
            paddingVertical: 12,
            fontSize: 16,
            marginBottom: spacing.sm,
          }}
        />

        <FlatList
          data={targets}
          keyExtractor={(t) => `${t.kind}:${t.id}`}
          style={{ flex: 1 }}
          renderItem={({ item }) => {
            const key = `${item.kind}:${item.id}`;
            const isSelected = selected.has(key);
            return (
              <Pressable
                onPress={() => toggle(item)}
                style={({ pressed }) => [
                  {
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: spacing.sm,
                    gap: spacing.md,
                    backgroundColor: pressed ? colors.bgSurfaceAlt : 'transparent',
                  },
                ]}
              >
                <Avatar uri={item.avatarUrl} displayName={item.name} size={44} />
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {item.kind === 'group' ? (
                    <Ionicons name="people" size={14} color={colors.textSecondary} />
                  ) : null}
                  <Text variant="bodyMedium" numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
                <Ionicons
                  name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                  size={22}
                  color={isSelected ? colors.brandPrimary : colors.textTertiary}
                />
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={{ paddingTop: 48, alignItems: 'center' }}>
              <Text variant="body" color="tertiary">
                No matching chats or groups.
              </Text>
            </View>
          }
        />

        <Button
          label={
            sending ? 'Forwarding…' : `Forward${selected.size > 0 ? ` (${selected.size})` : ''}`
          }
          onPress={handleConfirm}
          disabled={selected.size === 0 || sending}
        />
      </Screen>
    </Modal>
  );
}
