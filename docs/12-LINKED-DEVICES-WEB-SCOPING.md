# 12 — Linked Devices / Web Client: Scoping (not built)

**Status: scoping only, 2026-09-19. Nothing in this document is built.** No web-client route, no pairing UI, no `linked_devices` table exists. This doc exists so that when this feature is actually scheduled, it starts from a real design pass instead of getting bolted on — the same discipline `docs/11-VOICE-VIDEO-CALLS-SCOPING.md` applied to calls. Per the user's own explicit choice (2026-09-19): scope now, build later.

**The ask, restated precisely:** a QR-code-based "Link a device" flow, modeled on WhatsApp's own Linked Devices feature, reachable from the home screen's three-dot overflow menu (alongside Settings) — scan a QR code shown on a computer to use InvolveMe from a browser, mirroring "100%" of WhatsApp's own linking UX and behavior.

This is a **multi-week, cross-cutting feature** — a new authentication/session-pairing protocol with real security stakes for an app that custodies user funds, a second client surface with its own platform gaps, and a genuine compliance question about extending financial actions to a browser session. It should be built as its own project with its own milestones, same posture `docs/11` already established for calls.

## 1. The one finding that changes this doc's whole shape: a web build already exists

Every PR shipped this session was verified with `npx expo export --platform web` — this app **already builds and bundles for web today**, confirmed live dozens of times, not assumed. Expo Router's web target is a real, working output of this exact codebase, not a hypothetical. This means "build a web client" is **not** "build a second product from scratch" the way it would be for a typical native-only app — it's "make this codebase's existing web build good enough to actually use, and wire up a way to authenticate it as a linked companion session," which is a meaningfully smaller (though still real) lift.

**What still has to change for the web build to be a genuine WhatsApp-Web-equivalent, not just "the app happens to compile for web":**

- **Every native-only module needs a real web behavior, not just "doesn't crash."** `expo-contacts` (device-contacts sync/matching), `expo-local-authentication` (the app-lock biometric gate), `expo-image-picker`/camera capture (status photos, profile photos), and Expo push notifications (`lib/push.ts`, tied to a device's push token) have no browser equivalent. Each needs an explicit decision, not a silent no-op: contacts sync and the biometric lock plausibly become "don't apply on web" (the chat list on web would need to fall back to phone-number/`display_name` only — no contacts source exists on a computer); photo capture becomes "choose a file" via the browser's own file picker (Expo's `expo-image-picker` has partial web support already — needs a real check, not an assumption); push notifications need either Web Push (a separate, non-trivial integration) or an explicit "notifications don't work on the web client yet" disclosure.
- **Layout**: this app's UI is built phone-width-first (single-column screens, bottom tab bar). A genuinely usable web client needs at least a two-pane layout (chat list + open thread side by side, WhatsApp Web's own signature layout) — a real, non-trivial responsive redesign, not a CSS tweak.
- **The web build today is a static export** (`expo export --platform web` produces a static bundle for this session's own CI bundle-checks) — a real deployment needs continuous hosting for that bundle (a static host or a small server), not just a local export artifact.

## 2. The pairing protocol — the actual hard, security-sensitive part

**Real security model, modeled on WhatsApp's own approach:** the web page is untrusted until proven otherwise. It must never be capable of authenticating itself — only the already-authenticated, trusted phone can vouch for it. Concretely:

1. The web page (not yet authenticated) requests a pairing session from a new Edge Function (e.g. `create-device-pairing`) and receives a short-lived, single-use `pairing_id` (WhatsApp's own QR codes expire in roughly a minute — matching that window is a reasonable default, config-driven per this app's own "pricing/timing knobs live in config" convention).
2. The web page renders that `pairing_id` as a QR code and begins polling (or subscribes via Realtime) for the pairing to complete.
3. The **phone app** (already logged in — this is the trust anchor) scans the QR code with its camera and calls a second new Edge Function (e.g. `confirm-device-pairing`) with `{ pairing_id }`, authenticated as the real, already-signed-in user.
4. `confirm-device-pairing` mints a real session for the **same user** and associates it with a new row in a `linked_devices` table (device label, platform/user agent, linked_at, last_active_at), then the web page's poll/subscription picks up the new session and the browser is now signed in.

**The one genuinely open technical question, not resolved here — verify live before building, don't assume:** minting a real Supabase Auth session for an already-known user, server-side, without that user re-authenticating via OTP on the new device, is not a plainly-documented one-line Supabase Auth Admin API call (checked live, 2026-09-19 — the closest documented primitive is `admin.generateLink`, intended for magic-link/invite flows, whose suitability for "mint a session on confirmation from a _different_, already-authenticated device" has not been verified against this project's actual Supabase version). This is the load-bearing piece the whole pairing flow depends on — resolve it with a real, live test against this project's own Supabase instance before writing any other code, the same "prove the round-trip in isolation first" step `docs/11` §8 recommends for LiveKit.

**Real attack surface to close before shipping, not after:**

- **QR replay/shoulder-surfing**: a `pairing_id` must be single-use and expire fast (see above) — a QR code left visible on a shared screen is a real account-takeover vector otherwise.
- **No silent re-pairing**: confirming a pairing should require the phone to be unlocked (respect `useAppLock`'s existing gate) at the moment of confirmation, not just "the app happened to be open."
- **Visibility and revocation are mandatory day-one, not a follow-up**: a "Linked Devices" settings screen listing every active `linked_devices` row with a "Log out" action per device, and a "log out of all other devices" bulk action — WhatsApp treats this as core to the feature, not optional, precisely because a linked session is a standing risk the user needs a way to see and kill.

## 3. Data model sketch (not built — shape only)

- `linked_devices`: `id, user_id, label (e.g. "Chrome on Windows"), platform, linked_at, last_active_at, revoked_at`.
- `device_pairings`: `id (the QR-encoded pairing_id), created_at, expires_at, confirmed_by_user_id, confirmed_at, linked_device_id` — a short-lived, single-use row, not a long-term record; worth a scheduled cleanup job (this app already has `pg_cron` wired for other sweeps) for expired/unconfirmed rows.
- Both tables need `SECURITY DEFINER` functions for every write (CLAUDE.md rule #11's explicit grant pattern applies in full — a linked-device row is exactly the kind of security-sensitive write that must never be client-writable directly).

## 4. Compliance / fraud angle — a second look needed, same posture as calls

This app already treats a payer's own wallet/withdrawal actions as the highest-sensitivity surface in the product (`docs/06-SECURITY-FRAUD-LOOPHOLES.md`). A linked web session is a **new, standing authentication surface** for that same wallet — a phished or shoulder-surfed QR code becomes a real path to draining a wallet or changing withdrawal bank details, not just reading messages.

**A reasonable, explicit MVP scope cut, not a permanent restriction:** ship linked-device sessions as **chat-and-status only** — no top-up, no withdrawal, no bank-account changes, no credit transfers from a non-primary (non-mobile) session, at least for v1. This mirrors a real, common pattern in other financial-adjacent products (treat the original device as the trusted "root" session, secondary sessions as reduced-privilege) and meaningfully shrinks the fraud surface this feature would otherwise open on day one. Revisit once the pairing protocol itself has a real security track record.

This also needs its own line in `docs/07-COMPLIANCE-LEGAL.md`'s pre-launch checklist once scheduled, same as the multi-currency and peer-to-peer-transfer items already there — a new authentication surface for a money-custodying product is exactly the kind of change that document's own regulatory posture section calls for flagging before shipping live.

## 5. Mobile-side scope: the "Link a device" entry point

Per the explicit ask — a new item in the home screen's three-dot overflow menu (`AppHeader`'s existing `menuItems`, alongside "Settings") opening a scanner screen:

- Needs camera access (`expo-camera`, a genuinely new native dependency — `expo-image-picker`'s camera capture is for photos, not a live QR-scanning viewfinder; this is a real, new native module addition, joining the already-held `eas build` queue this app has carried since Batch C1/E1/F).
- The scanner screen decodes the QR payload (`pairing_id`), confirms with the user ("Link this device?" — showing whatever metadata the pairing request can supply, e.g. a browser name from the user agent WhatsApp itself shows), then calls `confirm-device-pairing`.
- A companion "Linked Devices" screen (reachable from Settings) listing active sessions with per-device and bulk revocation, per §2 above.

## 6. Suggested first milestone, if/when this is picked up

Not a commitment — a concrete starting point, same shape as `docs/11` §8:

1. **Resolve §2's one open question first, in isolation**: a throwaway script proving (or disproving) that a `service_role` Supabase client can mint a real, usable session for an existing user on confirmation from a separate, already-authenticated request — before any UI or protocol code is written. If this isn't possible with Supabase's own Admin API as-is, the whole design needs to be reconsidered (e.g., a custom JWT issued by this app's own Edge Functions rather than a native Supabase Auth session — a materially different, larger design fork worth knowing about immediately, not discovering mid-build).
2. **Migration + Edge Functions** for `linked_devices`/`device_pairings`, `create-device-pairing`/`confirm-device-pairing`, tested for ledger-conservation-style correctness the same rigor every wallet-adjacent migration in this repo already gets (concurrency: two devices scanning the same QR code shouldn't both succeed; expiry: a stale `pairing_id` must hard-fail, not silently pair).
3. **The web client's minimum-viable platform-gap pass** (§1) — decide and document the web fallback for each native-only module before building the pairing UI on top of a web target that can't actually use half the app yet.
4. **The scanner + Linked Devices settings screen** on mobile (§5), gated on the `eas build` this needs regardless (a new camera-scanning native module).
5. **The chat-and-status-only MVP restriction** (§4) enforced server-side (a linked session's own JWT/claim distinguishing it from the primary mobile session, checked inside every wallet-touching Edge Function) — not just a client-side UI omission, which would be trivially bypassable.

## Non-goals for any v1 of this feature (explicit, not just unlisted)

Wallet/withdrawal/bank-account actions from a linked session (§4), offline support on the web client, more than one linked device active at a time (WhatsApp itself caps this — a reasonable number to adopt without re-deriving one), a native desktop app (Electron or otherwise) — the web browser target is the whole of "the web client" for v1.
