import type { PropsWithChildren } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, type ViewProps } from 'react-native';

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
 * Not verified on a real Android device (none available in this
 * environment — see docs/00-SESSION-HANDOFF.md's recurring note on this);
 * this follows the documented behavior of `windowSoftInputMode`/
 * `KeyboardAvoidingView` rather than a device-confirmed measurement. Flag
 * for a real-device pass alongside the rest of this session's UI fixes.
 */
export function KeyboardAvoidingScreen({
  children,
  style,
  isModal = false,
  keyboardVerticalOffset = 0,
  ...rest
}: PropsWithChildren<ViewProps & { isModal?: boolean; keyboardVerticalOffset?: number }>) {
  return (
    <KeyboardAvoidingView
      style={[styles.flex, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : isModal ? 'height' : undefined}
      keyboardVerticalOffset={keyboardVerticalOffset}
      {...rest}
    >
      {children}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
