import { Modal, Pressable, View } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

export interface ActionSheetAction {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  actions: ActionSheetAction[];
  /** Optional heading above the actions, e.g. the person's name — omitted
   * when there's nothing more specific to say than the actions themselves. */
  title?: string;
}

/** Bottom-anchored action sheet — the standard iOS/Android pattern for "a
 * short list of actions on the thing I just tapped" (this app's first use:
 * tapping a chat-list avatar for Message/Profile). Reusable rather than a
 * one-off for that, since B3 (find-user) and future features want the
 * same pattern. A plain `Modal`, same "no bottom-sheet library, stay lite"
 * call `NewChatModal` already made for its own modal. */
export function ActionSheet({ visible, onClose, actions, title }: ActionSheetProps) {
  const { colors, spacing, radius } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          justifyContent: 'flex-end',
          padding: spacing.lg,
        }}
      >
        <Pressable onPress={(e) => e.stopPropagation()} style={{ gap: spacing.sm }}>
          <View
            style={{
              backgroundColor: colors.bgSurface,
              borderRadius: radius.card,
              overflow: 'hidden',
            }}
          >
            {title ? (
              <View
                style={{
                  paddingVertical: spacing.md,
                  paddingHorizontal: spacing.lg,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.borderSubtle,
                }}
              >
                <Text variant="caption" color="tertiary" style={{ textAlign: 'center' }}>
                  {title}
                </Text>
              </View>
            ) : null}
            {actions.map((action, index) => (
              <Pressable
                key={action.label}
                onPress={() => {
                  onClose();
                  action.onPress();
                }}
                style={({ pressed }) => [
                  {
                    paddingVertical: spacing.md,
                    paddingHorizontal: spacing.lg,
                    borderTopWidth: index > 0 || title ? 1 : 0,
                    borderTopColor: colors.borderSubtle,
                  },
                  pressed ? { backgroundColor: colors.bgSurfaceAlt } : null,
                ]}
              >
                <Text
                  variant="bodyMedium"
                  color={action.destructive ? 'danger' : 'primary'}
                  style={{ textAlign: 'center' }}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={onClose}
            style={({ pressed }) => [
              {
                backgroundColor: colors.bgSurface,
                borderRadius: radius.card,
                paddingVertical: spacing.md,
              },
              pressed ? { backgroundColor: colors.bgSurfaceAlt } : null,
            ]}
          >
            <Text variant="bodyMedium" color="secondary" style={{ textAlign: 'center' }}>
              Cancel
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
