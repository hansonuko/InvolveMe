import { Pressable, StyleSheet, type PressableProps } from 'react-native';

import { useTheme } from '@/theme';

import { Text } from './Text';

interface Props extends PressableProps {
  label: string;
  variant?: 'primary' | 'secondary';
}

/** Primitive button. Motion (press spring, loading states) lands in Phase 4 — see docs/04-DESIGN-SYSTEM.md. */
export function Button({ label, variant = 'primary', style, disabled, ...rest }: Props) {
  const { colors, radius: r, spacing } = useTheme();
  const bg = variant === 'primary' ? colors.brandPrimary : colors.bgSurfaceAlt;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      style={(state) => [
        styles.base,
        {
          backgroundColor: bg,
          borderRadius: r.pill,
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.xl,
          opacity: disabled ? 0.5 : state.pressed ? 0.85 : 1,
        },
        typeof style === 'function' ? style(state) : style,
      ]}
      {...rest}
    >
      <Text
        variant="bodyMedium"
        color={variant === 'primary' ? undefined : 'primary'}
        style={variant === 'primary' ? styles.onBrand : undefined}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  onBrand: { color: '#FFFFFF' },
});
