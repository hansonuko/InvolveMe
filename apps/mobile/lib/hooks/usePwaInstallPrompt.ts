import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/** Chrome's own install-prompt event — not in TS's standard DOM lib yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandaloneDisplay() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari's own non-standard flag — `display-mode: standalone`
    // isn't reliably reported there even once actually installed.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari() {
  const ua = window.navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  // Every iOS browser (Chrome, Firefox, etc.) is a WebKit wrapper that
  // still reports "Safari" in its UA, so excluding "CriOS"/"FxiOS" is
  // required to not fire this for, say, iOS Chrome too.
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari;
}

/**
 * Shared install-prompt plumbing (docs/22-FULL-PWA-SCOPING.md §5/§9 Phase
 * A) — originally only `components/InstallPwaPrompt.tsx`'s own floating
 * banner, extracted so `WebDevicePairingScreen`'s own explicit "Install
 * Web App" menu button (docs/12-LINKED-DEVICES-WEB-SCOPING.md) can trigger
 * the exact same real install prompt instead of a second, slightly-
 * different copy of this same `beforeinstallprompt` subscription logic.
 *
 * `canInstall` is only ever true on Android/desktop Chrome, which support
 * a real native install prompt; iOS Safari has no such API at all, hence
 * `isIosSafari`/`isAlreadyInstalled` so a caller can render its own manual
 * "Share → Add to Home Screen" instructions for that case instead.
 */
export function usePwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const promptInstall = async (): Promise<boolean> => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return outcome === 'accepted';
  };

  return {
    canInstall: Platform.OS === 'web' && !!deferredPrompt,
    promptInstall,
    isIosSafari: Platform.OS === 'web' && isIosSafari(),
    isAlreadyInstalled: Platform.OS === 'web' && isStandaloneDisplay(),
  };
}
