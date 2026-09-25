import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

/**
 * Base screen wrapper — canvas background + safe area, per docs/04-DESIGN-SYSTEM.md.
 * Every top-level screen should render inside one of these instead of a bare View.
 *
 * Defaults to all four edges, which is correct for a screen using
 * `AppHeader` (a plain in-content component — see its own header comment —
 * that relies on this top inset itself). A screen with a *native*
 * `Stack.Screen` header (`headerShown: true`) must instead pass
 * `edges={['right', 'bottom', 'left']}` here: the native header already
 * renders within the top safe area, so reserving `insets.top` again inside
 * this component's own content double-pads and shows up as a real, visible
 * blank strip between the header and the first bit of content — a real bug
 * found and fixed this way on the 1:1 thread screen, then applied to every
 * other native-header screen sharing the same root cause.
 */
export function Screen({
  children,
  style,
  edges,
  ...rest
}: PropsWithChildren<ViewProps & { edges?: readonly Edge[] }>) {
  const { colors } = useTheme();
  return (
    <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: colors.bgCanvas }]}>
      <View style={[styles.flex, styles.padded, style]} {...rest}>
        {children}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  padded: { paddingHorizontal: 16 },
});
