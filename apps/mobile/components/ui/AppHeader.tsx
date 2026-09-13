import { useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { Text } from './Text';

export interface AppHeaderMenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

interface AppHeaderProps {
  title: string;
  /** The one wordmark treatment (Chats tab only, per docs/04-DESIGN-SYSTEM.md
   * §2 — "InvolveMe" reads as a brand mark there, every other tab keeps a
   * plain screen-title header). */
  brand?: boolean;
  /** A persistent action next to the title (e.g. Chats' "+" new-chat
   * button) — for anything frequent enough that burying it in the overflow
   * menu would slow people down. */
  rightSlot?: ReactNode;
  /** Rare/secondary actions (Settings, etc.) behind a three-dot overflow —
   * only rendered when non-empty, so screens with nothing to put there
   * don't grow an empty button. */
  menuItems?: AppHeaderMenuItem[];
}

/**
 * Shared fixed header for the (tabs) screens — see
 * docs/00-SESSION-HANDOFF.md's header/nav overhaul section for why this
 * exists: every tab screen used to render its own ad-hoc title `<Text>`
 * *and* Expo Router's own default `Tabs` header rendered underneath it
 * (screenOptions never set `headerShown: false`) — two stacked headers on
 * every tab. `(tabs)/_layout.tsx` now turns the native one off entirely;
 * this is the only header each tab screen gets.
 *
 * Deliberately not wrapped in its own SafeAreaView/inset padding — it
 * relies on `Screen`'s existing SafeAreaView for the top inset, the same
 * mechanism the old inline titles already sat correctly under. What it
 * fixes structurally is different: as a non-scrolling sibling placed
 * *before* a screen's scrollable body (never inside it), content can't
 * scroll up behind/over it — see wallet.tsx's fix, where the old title lived
 * as the first child *inside* the ScrollView and scrolled away with
 * everything else.
 */
export function AppHeader({ title, brand, rightSlot, menuItems }: AppHeaderProps) {
  const { colors, spacing, radius } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <View
      style={[
        styles.row,
        {
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.md,
          backgroundColor: colors.bgCanvas,
        },
      ]}
    >
      <Text variant={brand ? 'brand' : 'display'} color={brand ? 'brand' : 'primary'}>
        {title}
      </Text>

      {/* ~24dp between the "+" and "⋮" actions per the 2026-09-13 wine
          rebrand's header spec (docs/00-SESSION-HANDOFF.md) — spacing.lg
          (16) read as too tight side by side. */}
      <View style={[styles.actions, { gap: spacing.xl }]}>
        {rightSlot}

        {menuItems?.length ? (
          <>
            <Pressable
              onPress={() => setMenuOpen(true)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="More options"
            >
              <Text variant="title" color="secondary">
                ⋮
              </Text>
            </Pressable>

            <Modal
              visible={menuOpen}
              transparent
              animationType="fade"
              onRequestClose={() => setMenuOpen(false)}
            >
              <Pressable style={styles.backdrop} onPress={() => setMenuOpen(false)}>
                <View
                  style={[
                    styles.menu,
                    {
                      backgroundColor: colors.bgSurface,
                      borderColor: colors.borderSubtle,
                      borderRadius: radius.card,
                      right: spacing.lg,
                      top: spacing.xxl,
                    },
                  ]}
                >
                  {menuItems.map((item) => (
                    <Pressable
                      key={item.label}
                      onPress={() => {
                        setMenuOpen(false);
                        item.onPress();
                      }}
                      style={({ pressed }) => [
                        { paddingVertical: spacing.md, paddingHorizontal: spacing.lg },
                        pressed ? { backgroundColor: colors.bgSurfaceAlt } : null,
                      ]}
                    >
                      <Text variant="bodyMedium" color={item.destructive ? 'danger' : 'primary'}>
                        {item.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Pressable>
            </Modal>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  backdrop: { flex: 1 },
  menu: { position: 'absolute', borderWidth: 1, minWidth: 160, overflow: 'hidden' },
});
