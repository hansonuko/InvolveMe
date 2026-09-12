import type { PropsWithChildren } from 'react';
import { StyleSheet, View, type ViewProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

/**
 * Base screen wrapper — canvas background + safe area, per docs/04-DESIGN-SYSTEM.md.
 * Every top-level screen should render inside one of these instead of a bare View.
 */
export function Screen({ children, style, ...rest }: PropsWithChildren<ViewProps>) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: colors.bgCanvas }]}>
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
