import { useEffect } from 'react';
import { Image, StyleSheet } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';

/**
 * A brief animated hand-off from the native static splash screen (OS-level,
 * can't itself be animated — a real platform constraint, not a corner cut)
 * to the real app: this mounts showing the exact same mark/background as
 * the native splash (app.json's expo-splash-screen config), hides the
 * native splash the instant it's ready so there's no blank-frame gap, plays
 * a short scale+fade entrance, then fades out once `ready` (session/auth
 * state resolved) flips true. Same background color and mark asset as the
 * native config on purpose — this must look like a continuation of the
 * native splash, not a visibly different second screen.
 */
export function AnimatedSplash({ ready, onFinished }: { ready: boolean; onFinished: () => void }) {
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(reducedMotion ? 1 : 0.85);
  const markOpacity = useSharedValue(reducedMotion ? 1 : 0);
  const overlayOpacity = useSharedValue(1);

  useEffect(() => {
    void SplashScreen.hideAsync();
    if (!reducedMotion) {
      scale.value = withTiming(1, { duration: 450, easing: Easing.out(Easing.cubic) });
      markOpacity.value = withTiming(1, { duration: 350 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    overlayOpacity.value = withTiming(0, { duration: 300 }, (finished) => {
      if (finished) runOnJS(onFinished)();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const markStyle = useAnimatedStyle(() => ({
    opacity: markOpacity.value,
    transform: [{ scale: scale.value }],
  }));
  const overlayStyle = useAnimatedStyle(() => ({ opacity: overlayOpacity.value }));

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.overlay, overlayStyle]}
      pointerEvents="none"
    >
      <Animated.View style={markStyle}>
        <Image
          source={require('@/assets/images/splash-icon.png')}
          style={styles.mark}
          resizeMode="contain"
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: '#5F1B31',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  mark: {
    width: 240,
    height: 240,
  },
});
