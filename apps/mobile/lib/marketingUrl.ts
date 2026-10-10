// Shared by WebDevicePairingScreen.tsx and InstallPwaPrompt.tsx — both need
// to link out to the marketing site (How it works, legal pages, the
// Android download page). involvemechat.com is the real, live custom
// domain (Cloudflare Pages, since 2026-10-09); the .pages.dev fallback
// stays in case a build's env is stale.
export const MARKETING_URL = process.env.EXPO_PUBLIC_MARKETING_URL ?? 'https://involvemechat.com';
