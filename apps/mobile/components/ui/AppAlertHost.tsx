import { Modal, Pressable, View } from 'react-native';

import { useAlertQueueStore, type AlertButton } from '@/lib/ui/alert';
import { useTheme } from '@/theme';

import { Text } from './Text';

/** Themed replacement for the OS-default `Alert.alert` box — mounted once
 * at the app root (app/_layout.tsx), reading lib/ui/alert.ts's queue.
 * Centered card, not ActionSheet's bottom-anchored sheet (that component's
 * own pattern for "a list of actions on something you tapped"; this one is
 * "a message plus one or more responses" — the same distinction native
 * iOS/Android draw between an action sheet and an alert dialog). Buttons
 * lay out as a row for one or two (matches WhatsApp/iOS's own alert
 * layout), stacked for three or more so a long destructive-confirm list
 * (e.g. the batch-delete "for me" / "for everyone" / cancel case) never
 * has to squeeze three labels into one row. */
export function AppAlertHost() {
  const { colors, spacing, radius } = useTheme();
  const current = useAlertQueueStore((s) => s.queue[0]);
  const dismissCurrent = useAlertQueueStore((s) => s.dismissCurrent);

  if (!current) return null;

  const handlePress = (button: AlertButton) => {
    dismissCurrent();
    button.onPress?.();
  };

  const buttonTextColor = (style: AlertButton['style']) => {
    if (style === 'destructive') return 'danger';
    if (style === 'cancel') return 'secondary';
    return 'brand';
  };

  const stacked = current.buttons.length > 2;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => dismissCurrent()}>
      <View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.5)',
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.xl,
        }}
      >
        <View
          style={{
            width: '100%',
            maxWidth: 320,
            backgroundColor: colors.bgSurface,
            borderRadius: radius.card,
            overflow: 'hidden',
          }}
        >
          <View style={{ padding: spacing.lg, gap: spacing.xs }}>
            <Text variant="bodyMedium" color="primary" style={{ textAlign: 'center' }}>
              {current.title}
            </Text>
            {current.message ? (
              <Text variant="caption" color="secondary" style={{ textAlign: 'center' }}>
                {current.message}
              </Text>
            ) : null}
          </View>

          <View
            style={{
              flexDirection: stacked ? 'column' : 'row',
              borderTopWidth: 1,
              borderTopColor: colors.borderSubtle,
            }}
          >
            {current.buttons.map((button, index) => (
              <Pressable
                key={button.text}
                onPress={() => handlePress(button)}
                style={({ pressed }) => [
                  {
                    flex: stacked ? undefined : 1,
                    paddingVertical: spacing.md,
                    paddingHorizontal: spacing.sm,
                    borderTopWidth: stacked && index > 0 ? 1 : 0,
                    borderTopColor: colors.borderSubtle,
                    borderLeftWidth: !stacked && index > 0 ? 1 : 0,
                    borderLeftColor: colors.borderSubtle,
                  },
                  pressed ? { backgroundColor: colors.bgSurfaceAlt } : null,
                ]}
              >
                <Text
                  variant="bodyMedium"
                  color={buttonTextColor(button.style)}
                  style={{ textAlign: 'center' }}
                >
                  {button.text}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}
