import { Platform, useWindowDimensions } from 'react-native';

// docs/12-LINKED-DEVICES-WEB-SCOPING.md Milestone 7 — the one breakpoint
// the two-pane chat layout gates on. Wide enough for a real sidebar
// (~320px) plus a usable thread pane next to it, not just "wider than a
// phone" — a tablet-width browser window still gets the normal
// single-pane flow rather than a cramped split.
const WIDE_WEB_BREAKPOINT = 900;

/** True only for a web browser tab wide enough to show the chat-list
 * sidebar next to an open thread (docs/12 Milestone 7's two-pane layout)
 * — always `false` on native, where this screen-width split has never
 * applied and still doesn't. Reactive to window resizing
 * (`useWindowDimensions`), not just the width at mount. */
export function useIsWideWeb(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === 'web' && width >= WIDE_WEB_BREAKPOINT;
}
