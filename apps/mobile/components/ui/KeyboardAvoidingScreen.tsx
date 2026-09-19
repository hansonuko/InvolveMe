import { useEffect, useState, type PropsWithChildren } from 'react';
import { Keyboard, Platform, StyleSheet, View, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * Real device confirmed (2026-09-19, punch-list follow-up): the previous
 * `KeyboardAvoidingView`-based implementation still left the composer
 * hidden behind the keyboard, completely fixed in place — not just
 * padded by the wrong amount, which is what the immediately-prior fix
 * (a `keyboardVerticalOffset` correction for a native header) targeted.
 * The tell: this app's own emoji picker panel (`components/chat/
 * EmojiPicker.tsx`), which is not a keyboard at all — it's a plain View
 * added to the bottom of the same flex column — correctly pushes the
 * composer up, because that's just ordinary React Native layout: adding
 * height at the bottom of a flex column shrinks/shifts everything above
 * it. The real keyboard doing nothing at all, while a same-shaped plain
 * View does exactly the right thing, means `KeyboardAvoidingView` itself
 * was never successfully reacting to the keyboard opening on this
 * device — most likely Android's edge-to-edge display mode (on by
 * default in recent Expo/React Native versions), under which
 * `windowSoftInputMode="adjustResize"` no longer actually resizes the
 * window the way `KeyboardAvoidingView`'s "padding"/"height" behaviors
 * assume, so nothing here was ever reading the real keyboard height in
 * the first place — a wrong offset was never going to fix a mechanism
 * that wasn't firing at all.
 *
 * The fix: don't ask the OS to resize anything, and don't ask
 * `KeyboardAvoidingView` to infer the keyboard's height from window
 * geometry. Measure it directly from `Keyboard`'s own show/hide events
 * (`endCoordinates.height` — a real, reported keyboard frame height,
 * independent of window-resize behavior on either platform) and render a
 * plain spacer `View` of that height at the bottom of this component's
 * own children — the exact same mechanism the emoji picker already uses
 * successfully, applied to the real keyboard instead of a fixed-height
 * panel. `Screen`'s own `SafeAreaView` already reserves `insets.bottom`
 * unconditionally; the spacer only needs to add whatever the keyboard
 * requires *beyond* that already-reserved space, or a real keyboard would
 * leave an extra gap under it once the safe-area padding and the full
 * keyboard height were both applied.
 *
 * `isModal`/`keyboardVerticalOffset`, this component's old
 * `KeyboardAvoidingView`-specific props, are gone — neither concept
 * applies to this mechanism (there's no window-resize behavior to
 * distinguish "modal" from "screen" for, and no header-offset frame math
 * to correct), so every call site had those props removed too rather
 * than keeping them as unused dead weight.
 */
function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      setHeight(0);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}

export function KeyboardAvoidingScreen({ children, style, ...rest }: PropsWithChildren<ViewProps>) {
  const keyboardHeight = useKeyboardHeight();
  const insets = useSafeAreaInsets();
  const spacerHeight = Math.max(keyboardHeight - insets.bottom, 0);

  return (
    <View style={[styles.flex, style]} {...rest}>
      <View style={styles.flex}>{children}</View>
      <View style={{ height: spacerHeight }} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
