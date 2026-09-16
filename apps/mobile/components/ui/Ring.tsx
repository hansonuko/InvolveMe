import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface Props {
  size: number;
  /** Stroke width in px. */
  strokeWidth?: number;
  /** 0..1 — fraction of the ring drawn, clockwise from 12 o'clock. */
  progress: number;
  /** One color = a solid stroke; two = a diagonal gradient stroke. */
  colors: readonly [string] | readonly [string, string];
  /** Faint full-circle background track. Omit for no track. */
  trackColor?: string;
  /** Animate `progress` changes. Also gated by the OS reduced-motion
   * setting — when either is off, the ring still renders at the target
   * progress, just without the transition (docs/04-DESIGN-SYSTEM.md's
   * reduced-motion rule: countdown rings still show, no pulse). */
  animated?: boolean;
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Shared circular-progress ring — status "seen/unseen" rings and the
 * wallet withdrawal countdown both wrap this rather than each rolling
 * their own SVG. `react-native-svg` has no native conic-gradient
 * primitive, so a two-color `colors` renders as a diagonal linear
 * gradient across the stroke, which reads as "a gradient ring" without
 * being a pixel-exact conic sweep — the standard practical approximation
 * for this on React Native. */
export function Ring({
  size,
  strokeWidth = 3,
  progress,
  colors,
  trackColor,
  animated = true,
  children,
  style,
}: Props) {
  const reducedMotion = useReducedMotion();
  const shouldAnimate = animated && !reducedMotion;

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(1, progress));

  const animatedProgress = useSharedValue(shouldAnimate ? 0 : clamped);

  useEffect(() => {
    if (shouldAnimate) {
      animatedProgress.value = withTiming(clamped, { duration: 600 });
    } else {
      animatedProgress.value = clamped;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamped, shouldAnimate]);

  const animatedProps = useAnimatedProps(() => ({
    strokeDashoffset: circumference * (1 - animatedProgress.value),
  }));

  const gradientId = 'ringGradient';

  return (
    <View
      style={[{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }, style]}
    >
      <Svg
        width={size}
        height={size}
        style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}
      >
        {colors.length === 2 ? (
          <Defs>
            <LinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <Stop offset="0%" stopColor={colors[0]} />
              <Stop offset="100%" stopColor={colors[1]} />
            </LinearGradient>
          </Defs>
        ) : null}
        {trackColor ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={trackColor}
            strokeWidth={strokeWidth}
            fill="none"
          />
        ) : null}
        <AnimatedCircle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke={colors.length === 2 ? `url(#${gradientId})` : colors[0]}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={circumference}
          animatedProps={animatedProps}
        />
      </Svg>
      {children}
    </View>
  );
}
