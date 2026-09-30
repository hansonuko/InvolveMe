import { create } from 'zustand';

/** Mirrors react-native's own `AlertButton` shape (the subset this app's
 * ~30 call sites actually use) — so replacing `Alert.alert(...)` with
 * `showAlert(...)` is a straight import swap, no call-site rewrites. */
export interface AlertButton {
  text: string;
  onPress?: () => void;
  style?: 'default' | 'cancel' | 'destructive';
}

interface QueuedAlert {
  key: number;
  title: string;
  message?: string;
  buttons: AlertButton[];
}

interface AlertQueueState {
  queue: QueuedAlert[];
  push: (alert: Omit<QueuedAlert, 'key'>) => void;
  dismissCurrent: () => void;
}

let nextKey = 0;

/** Backs AppAlertHost (components/ui/AppAlertHost.tsx), mounted once at the
 * app root. A plain array, not just "the current one" — react-native's own
 * Alert.alert queues back-to-back calls rather than the second silently
 * clobbering the first (a real case this app hits: a mutation's onError
 * firing its own alert right as another one is still on screen), and
 * matching that here avoids a lost/overwritten error the user never saw. */
export const useAlertQueueStore = create<AlertQueueState>((set) => ({
  queue: [],
  push: (alert) => set((s) => ({ queue: [...s.queue, { ...alert, key: nextKey++ }] })),
  dismissCurrent: () => set((s) => ({ queue: s.queue.slice(1) })),
}));

/** Drop-in themed replacement for react-native's `Alert.alert` (CLAUDE.md
 * "design tokens only" — the OS-default alert box has no way to pick up
 * this app's own colors/type/radius). Same signature: an omitted/empty
 * `buttons` array renders a single dismiss button reading "OK", exactly
 * like the native one defaults to. */
export function showAlert(title: string, message?: string, buttons?: AlertButton[]): void {
  useAlertQueueStore
    .getState()
    .push({ title, message, buttons: buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }] });
}
