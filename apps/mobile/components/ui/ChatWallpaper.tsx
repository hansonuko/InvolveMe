import { StyleSheet } from 'react-native';
import Svg, { Circle, Defs, Path, Pattern, Rect } from 'react-native-svg';

import { useTheme } from '@/theme';

/**
 * Subtle background pattern behind a thread's message list — the same
 * *concept* WhatsApp (leaf/phone doodles) and Telegram (paper planes/cats)
 * both use, deliberately different content so this doesn't read as a
 * clone: a small tile of InvolveMe's own motifs (a chat bubble, a coin,
 * a four-point "value" spark — chat + money, this app's whole premise)
 * instead of borrowed iconography.
 *
 * "Playful, transparent, colourless" per the ask — a single flat tone at
 * very low opacity, not a multi-color illustration. Built as a tiled SVG
 * `Pattern` (vector, scales to any screen for free, no image asset to
 * ship) rather than a raster wallpaper image — the tint is a theme color,
 * so light/dark mode each get a version that actually reads against
 * their own canvas instead of one fixed asset baked for one mode.
 */
export function ChatWallpaper() {
  const { colors } = useTheme();
  // Wine in light mode, white in dark — the same "on canvas" accent role
  // textSecondary already carries everywhere else (see theme/tokens.ts's
  // 2026-09-14 chrome-correction comment), at a near-invisible opacity so
  // the message bubbles stay the only thing actually competing for
  // attention.
  const tint = colors.textSecondary;

  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      opacity={0.06}
    >
      <Defs>
        <Pattern id="chatWallpaper" width={140} height={140} patternUnits="userSpaceOnUse">
          {/* Chat bubble, top-left of the tile */}
          <Path
            d="M14 18 h34 a8 8 0 0 1 8 8 v20 a8 8 0 0 1 -8 8 h-22 l-10 10 v-10 h-2 a8 8 0 0 1 -8 -8 v-20 a8 8 0 0 1 8 -8 z"
            stroke={tint}
            strokeWidth={2.5}
            fill="none"
          />
          {/* Coin, right side of the tile */}
          <Circle cx={112} cy={40} r={16} stroke={tint} strokeWidth={2.5} fill="none" />
          <Circle cx={112} cy={40} r={7} stroke={tint} strokeWidth={2} fill="none" />
          {/* Four-point "value" spark, bottom of the tile */}
          <Path
            d="M40 96 l4 12 l12 4 l-12 4 l-4 12 l-4 -12 l-12 -4 l12 -4 z"
            stroke={tint}
            strokeWidth={2.5}
            fill="none"
          />
          {/* Small second coin, lower-right, to break up the grid rhythm */}
          <Circle cx={104} cy={114} r={10} stroke={tint} strokeWidth={2} fill="none" />
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#chatWallpaper)" />
    </Svg>
  );
}
