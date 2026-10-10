import { Platform } from 'react-native';

// docs/22-FULL-PWA-SCOPING.md's original full-trust standalone app (its own
// phone-OTP login, the complete native-equivalent feature set) — superseded
// as involveme-web's *default* web experience by docs/12's QR-pairing
// companion (session 44's architecture pivot), then revived at this
// separate subdomain rather than conflated back into web.involvemechat.com
// (session 45 continued: the user explicitly wants both to coexist —
// web.involvemechat.com stays pairing-only, this domain is the
// store-restricted-device (iOS, etc.) installable alternative).
const FULL_PWA_HOSTNAME = 'app.involvemechat.com';

/** True only on the dedicated standalone-PWA domain — every other web host
 * this app is served from (web.involvemechat.com, involveme-web.pages.dev,
 * localhost during development) keeps the default QR-pairing companion
 * screen. `false` on native, where this distinction doesn't apply at all. */
export function isFullPwaHost(): boolean {
  return Platform.OS === 'web' && window.location.hostname === FULL_PWA_HOSTNAME;
}

/** UA-sniffed, not a `Platform.OS` check — `Platform.OS` is `'web'`
 * regardless of the device underneath a browser tab. Used purely to pick
 * install-prompt copy (Android vs. "everything else"), never for anything
 * security- or billing-relevant. */
export function isAndroidWeb(): boolean {
  return Platform.OS === 'web' && /android/i.test(window.navigator.userAgent);
}

/** True for a phone/tablet browser (iOS, Android, or any other mobile UA) —
 * the actual target audience `app.involvemechat.com` exists for (per the
 * explicit product requirement this domain is built on: "completely new
 * users who do not have access to the Android version since the app isn't
 * on any store yet"). Desktop is the one case that needs the
 * install-required gate (`StandaloneRequiredScreen`, `app/_layout.tsx`) —
 * mobile visitors get the full app directly in the browser, no install
 * wall, which is the entire point of offering it at all. */
export function isMobileWeb(): boolean {
  return (
    Platform.OS === 'web' && /android|iphone|ipad|ipod|mobile/i.test(window.navigator.userAgent)
  );
}
