import { Text as RNText, type TextProps } from 'react-native';

import { useTheme } from '@/theme';
import type { typography } from '@/theme/tokens';

type Variant = keyof typeof typography;

interface Props extends TextProps {
  variant?: Variant;
  color?:
    | 'primary'
    | 'secondary'
    | 'tertiary'
    | 'inverse'
    | 'brand'
    | 'success'
    | 'danger'
    | 'warning'
    | 'credit'
    | 'badge';
}

const colorTokenMap: Record<NonNullable<Props['color']>, string> = {
  primary: 'textPrimary',
  secondary: 'textSecondary',
  tertiary: 'textTertiary',
  inverse: 'textInverse',
  brand: 'brandPrimary',
  success: 'success',
  danger: 'danger',
  warning: 'warning',
  credit: 'accentCredit',
  // Foreground text for the unread-count pill (theme.colors.badgeBg is
  // its background) — see AppHeader.tsx-adjacent chats.tsx ThreadRow.
  badge: 'badgeText',
};

/** Themed text primitive — always route body copy through this, never a bare RN <Text>. */
export function Text({ variant = 'body', color = 'primary', style, ...rest }: Props) {
  const theme = useTheme();
  const colorValue = theme.colors[colorTokenMap[color] as keyof typeof theme.colors];
  return <RNText style={[theme.typography[variant], { color: colorValue }, style]} {...rest} />;
}
