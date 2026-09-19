import { useContext, type PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, type ViewProps } from 'react-native';

// expo-router vendors its own copy of @react-navigation/elements (there is
// no top-level @react-navigation/elements dependency anywhere in this
// repo) — importing HeaderHeightContext from THIS path, not a freshly
// installed @react-navigation/elements package, is deliberate: expo-router's
// own Stack/native-stack screens populate this exact Context instance from
// their own vendored copy. Installing a separate top-level package would
// create a second, disconnected Context object with the same name —
// `useContext` against it would then never see expo-router's real header
// height, silently always returning the default instead of erroring, which
// would be a much harder bug to catch than an import that just doesn't
// resolve.
import { HeaderHeightContext } from 'expo-router/build/react-navigation/elements';

/**
 * Single shared keyboard-avoidance wrapper — every screen/modal in this app
 * that has a `TextInput` near the bottom of its content should use this
 * instead of a bespoke `KeyboardAvoidingView`, per the 2026-09-18 punch-list
 * fix (item 4: the message composer and every input modal left the typed
 * text hidden behind the keyboard).
 *
 * `behavior="padding"` on iOS is the standard, well-documented choice.
 * Android is deliberately split in two, rather than using `"height"`
 * everywhere, because this app's Android build uses Expo's default
 * `windowSoftInputMode="adjustResize"` (nothing in app.json overrides it) —
 * the OS itself already resizes the window when the keyboard opens for a
 * normal full-screen route. Layering RN's own `"height"` behavior on top of
 * that double-compensates. A `Modal` (react-native's, used by every form in
 * this app) presents in its own native window that does **not** reliably
 * inherit that Activity-level resize, so those still need `"height"`
 * explicitly — `isModal` picks which of the two this instance is.
 *
 * **A real device confirmed a second, separate bug here (2026-09-19,
 * punch-list item 1) that two earlier code-review-only passes missed**: on
 * iOS, `KeyboardAvoidingView`'s own "padding" behavior computes the gap to
 * the keyboard by comparing its own `onLayout`-relative frame against the
 * keyboard's *absolute* screen position — when a native stack header
 * renders **above** this view (any `headerShown: true` screen, not a
 * `Modal`), those two coordinate spaces disagree by roughly the header's
 * own height unless `keyboardVerticalOffset` explicitly accounts for it.
 * The `KeyboardAvoidingView` wrapper itself was correctly in place around
 * the composer the whole time — it was just padding by the wrong amount,
 * which is exactly the kind of thing that reads as "already fixed" from
 * the code alone and only shows up once someone actually types on a real
 * phone. Fixed by defaulting `keyboardVerticalOffset` to the real header
 * height read from `HeaderHeightContext` — via plain `useContext`, not the
 * throwing `useHeaderHeight()` helper, so a `Modal` usage (which has no
 * header and no Provider at all) safely falls back to 0 instead of
 * crashing. Still not confirmed on a real Android device (none available
 * in this environment — see docs/00-SESSION-HANDOFF.md's recurring note on
 * this); the iOS half of this specific fix follows real-device confirmation
 * that the composer *was* hidden, the Android half follows the documented
 * `windowSoftInputMode` behavior as before.
 */
export function KeyboardAvoidingScreen({
  children,
  style,
  isModal = false,
  keyboardVerticalOffset,
  ...rest
}: PropsWithChildren<ViewProps & { isModal?: boolean; keyboardVerticalOffset?: number }>) {
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const resolvedOffset =
    keyboardVerticalOffset ?? (Platform.OS === 'ios' && !isModal ? headerHeight : 0);

  return (
    <KeyboardAvoidingView
      style={[styles.flex, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : isModal ? 'height' : undefined}
      keyboardVerticalOffset={resolvedOffset}
      {...rest}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
