// Platform-dispatching seam for E2EE key storage, web half (session 45
// continued — real WhatsApp-Web-style E2EE on web, not just a graceful
// "not supported" block). `expo-secure-store`'s own web implementation is
// a bare `export default {}` (confirmed by reading the package source
// directly) — nothing to build on, but also nothing subtle to work
// around: there is no way for a website to get OS-Keychain/Keystore-
// equivalent storage at all. This is the same answer every real browser
// E2EE client ships (WhatsApp Web, Signal Web, Matrix web clients):
// persist key material in the browser's own storage, protected by
// same-origin isolation and HTTPS, not a hardware secure enclave.
//
// Real, explicit security-tier difference from native, not a silent
// downgrade: a browser extension or an XSS vulnerability on this exact
// origin could read this; that is categorically not true of iOS Keychain
// / Android Keystore. Messages are still genuinely end-to-end encrypted
// either way — the server never sees plaintext or key material — this
// only affects how well *this device's own* keys are protected at rest.
export async function getItemAsync(key: string): Promise<string | null> {
  return window.localStorage.getItem(key);
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  window.localStorage.setItem(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  window.localStorage.removeItem(key);
}
