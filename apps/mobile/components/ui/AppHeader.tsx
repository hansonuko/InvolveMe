import { Ionicons } from '@expo/vector-icons';
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
 * *and* Expo Router's own default `Tabs` header rendered underneath it —
 * two stacked headers on every tab. `(tabs)/_layout.tsx` turns the native
 * one off entirely; this is the only header each tab screen gets.
 *
 * Deliberately not wrapped in its own SafeAreaView/inset padding — it
 * relies on `Screen`'s existing SafeAreaView for the top inset.
 *
 * **2026-09-14 chrome correction:** background was already the canvas
 * color (light milk / dark near-black) — that part didn't need fixing.
 * What did: the overflow icon is now a real vector icon (Ionicons,
 * `@expo/vector-icons`) rather than a plain "⋮" character (inconsistent
 * rendering across platform fonts was a real contributor to icons
 * "appearing broken"), sized up and given more breathing room per an
 * explicit size-up ask, and the bar itself is now a fixed
 * `layout.barHeight` (~0.6in) tall instead of content-height.
 */
// The ask was 0.17in (≈27dp at this app's 160dp/inch baseline). Capped to
// 8dp instead: `layout.barHeight` was reduced by 0.2in (32dp) in this same
// batch (96 -> 64), and content here is otherwise vertically centered in
// that bar — a full 27dp shift on top of the now-shorter bar would push
// the ~34-36dp-tall title text's top edge above the bar entirely (clipping
// it, and crowding the header icons the same way), not just move it up
// within the bar. 8dp keeps a real, visible "shifted up" effect (content
// center moves from the bar's true middle to noticeably above it) without
// clipping against the reduced height. Worth a real-device check once both
// changes land together — if there's more headroom than this estimate
// assumes, this can go higher; safer to under-shoot than ship a clipped
// header. Applied to the title+actions content only, via a nested
// wrapper, not to the outer row: shifting the row itself would drag its
// border-bottom (the boundary line against the content below) up with it,
// which isn't the ask.
const HEADER_CONTENT_SHIFT_UP = 8;

export function AppHeader({ title, brand, rightSlot, menuItems }: AppHeaderProps) {
  const { colors, spacing, radius, layout } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <View
      style={[
        styles.row,
        {
          height: layout.barHeight,
          paddingHorizontal: spacing.lg,
          backgroundColor: colors.bgCanvas,
          borderBottomWidth: 1,
          borderBottomColor: colors.borderSubtle,
        },
      ]}
    >
      <View style={[styles.content, { transform: [{ translateY: -HEADER_CONTENT_SHIFT_UP }] }]}>
        {/* color="secondary" (not "brand") even for the wordmark — brandPrimary
            is theme-invariant wine now (see tokens.ts), which would be
            near-invisible against a dark canvas in dark mode. textSecondary
            is the theme-adaptive accent role that's actually meant for
            on-canvas content. */}
        <Text variant={brand ? 'brand' : 'display'} color={brand ? 'secondary' : 'primary'}>
          {title}
        </Text>

        {/* Bigger gap than before — the icons themselves are bigger now too,
            so the old 24dp read as cramped next to them. */}
        <View style={[styles.actions, { gap: spacing.xxl }]}>
          {rightSlot}

          {menuItems?.length ? (
            <>
              <Pressable
                onPress={() => setMenuOpen(true)}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="More options"
              >
                <Ionicons
                  name="ellipsis-vertical"
                  size={layout.headerIconSize}
                  color={colors.textSecondary}
                />
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
                        top: layout.barHeight,
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
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'column' },
  content: { flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center' },
  backdrop: { flex: 1 },
  menu: { position: 'absolute', borderWidth: 1, minWidth: 160, overflow: 'hidden' },
});
