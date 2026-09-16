import { Image, View } from 'react-native';

import { useTheme } from '@/theme';

import { Ring } from './Ring';
import { Text } from './Text';

interface Props {
  uri?: string | null;
  /** Used to render initials when `uri` is absent — never a broken-image state. */
  displayName?: string | null;
  size: number;
  ringVariant?: 'unseen' | 'seen' | 'none';
}

function initialsFor(name: string | null | undefined): string {
  if (!name || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Shared avatar — a real image, or an initials fallback, optionally
 * wrapped in a status `Ring`. Status rings are a binary presence
 * indicator (has this poster got an unseen status, yes/no), not a
 * partial-progress arc, so `Ring` always gets `progress={1}` here —
 * that's the wallet countdown ring's job, not this one's. */
export function Avatar({ uri, displayName, size, ringVariant = 'none' }: Props) {
  const { colors } = useTheme();

  const inner = uri ? (
    <Image source={{ uri }} style={{ width: size, height: size, borderRadius: size / 2 }} />
  ) : (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.bgSurfaceAlt,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text variant="caption" color="secondary">
        {initialsFor(displayName)}
      </Text>
    </View>
  );

  if (ringVariant === 'none') {
    return inner;
  }

  const ringColors: readonly [string] | readonly [string, string] =
    ringVariant === 'unseen' ? [colors.brandPrimary, colors.accentCredit] : [colors.textTertiary];

  return (
    <Ring
      size={size + 8}
      strokeWidth={2.5}
      progress={1}
      colors={ringColors}
      animated={ringVariant === 'unseen'}
    >
      {inner}
    </Ring>
  );
}
