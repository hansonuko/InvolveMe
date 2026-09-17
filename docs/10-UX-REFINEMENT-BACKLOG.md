# 10 — UX Refinement Backlog (session 16 scoping pass)

Not committed yet — created for review. Every item below was investigated against the real code before being scoped (per explicit instruction: confirm state, don't assume). Nothing in this doc is built until the user gives the go-ahead per batch; each batch ships as its own PR, tested, then merged, same discipline as every other change in this repo.

Format per item: **Confirmed state** (cited) → **Refined spec** (best-practice write-up) → **Notes/open questions**.

---

## Batch A — Design-system foundation (theme + layout tokens) — ✅ shipped (PR #50)

Do this first: it's low-risk, touches shared tokens/components only (no schema, no new dependencies), and every other batch's screens inherit correct visuals from it.

**One deviation from spec, worth flagging:** A5's title/icon shift-up was built at **8dp, not the requested 27dp (0.17in)**. Combined with A4's height reduction (bar 96 → 64dp) landing in the same PR, the full 27dp shift would push the header title's text against/past the bar's top edge (real clipping, not a style nitpick — see `AppHeader.tsx`'s own comment for the arithmetic). No live device/simulator was available to confirm visually, so this was a conservative judgment call rather than a verified-safe number — worth a real-device check to see if there's more headroom than estimated and the shift can go higher.

### A1. Light/Dark mode toggle in Settings

**Confirmed state:** Not built. `ThemeProvider.tsx` derives mode 100% from `useColorScheme()` (OS setting) with no override mechanism and no persistence — its own comment says a manual override was scoped for later, not built. The dark palette itself is complete and correct in `theme/tokens.ts` (all 16 tokens populated) — nothing to design there, just needs a way to select it.
**Refined spec:** Add a `mode: 'system' | 'light' | 'dark'` preference, persisted (AsyncStorage, same storage this app already uses for the session), read by `ThemeProvider` and combined with `useColorScheme()` only when set to `'system'`. Settings gets a new "Appearance" section (System / Light / Dark, radio-style) placed near the top, above Account — matches iOS/Android platform convention (WhatsApp, Telegram both do exactly this three-way choice).
**Notes:** No open questions — straightforward.

### A2. Header color must match theme on every screen

**Confirmed state:** Partially built. The four tab screens (`chats`, `wallet`, `status`, and implicitly `calls`) all use the shared `AppHeader`, which is correctly theme-aware. **Settings and the thread/chat screen do not** — both use React Navigation's bare native `Stack.Screen` header with no `headerStyle`/`headerTintColor` set at all, so they render RN Navigation's default (unthemed) header regardless of app theme. This is the same root cause as A3 below.
**Refined spec:** Either (a) replace both screens' native headers with `AppHeader`, or (b) theme the native header via `headerStyle: { backgroundColor: colors.bgCanvas }` / `headerTintColor: colors.textSecondary` bound to `useTheme()`. Recommend (a) for consistency — one header implementation, one place to get right, matches how the other four screens already work.
**Notes:** This single fix also resolves A3 (the 3-dot contrast bug) and part of B2 (chat header), since they're the same underlying gap.

### A3. Three-dot menu icon contrast on chat screen header

**Confirmed state:** Confirmed real bug. `thread/[id].tsx`'s `headerRight` paints the ellipsis icon `colors.textSecondary` (near-white, `#F5EDE9`, in dark mode) against React Navigation's **unthemed default header background** (not this app's dark canvas) — a real background/icon mismatch, not hypothetical.
**Refined spec:** Fixed automatically by A2's fix (once the header itself is theme-aware, `textSecondary`-on-`bgCanvas` is a deliberately-designed, already-correct-contrast pairing per the existing tokens).

### A4. Header height −0.2in, footer (tab bar) height −0.2in

**Confirmed state:** Single source of truth already exists: `theme/tokens.ts`'s `layout.barHeight` (currently 96, used for both the header row height and the tab bar height, scaled 0.85–1.15× responsively) feeds exactly two consumers (`AppHeader.tsx` header row height, and the tab bar's `tabBarStyle.height`).
**Refined spec:** 0.2in ≈ 32dp at this app's own 160dp/inch baseline (documented in `tokens.ts`'s own comment). New `barHeight: 64`. One-line token change; both consumers pick it up automatically. Sanity-check against the 44×44pt minimum-tap-target rule (`docs/04-DESIGN-SYSTEM.md` §6) once icons are laid out inside the shorter bar.

### A5. Header titles/icons shift up 0.17in

**Confirmed state:** No existing offset token — title and icons are centered purely via `alignItems: 'center'` against the header row's height, with no independent vertical position value to adjust.
**Refined spec:** 0.17in ≈ 27dp. Add an explicit negative `marginTop`/`paddingBottom` adjustment (or switch `alignItems: 'center'` to a `paddingBottom`-based alignment) on `AppHeader`'s row content — scoped to a single component, applies everywhere consistently.
**Notes:** Worth doing A4 and A5 together and testing on one real device pass together — they interact (a shorter bar with content shifted up needs to be re-checked for clipping/overlap).

### A6. Chat screen padding → match wallet screen's padding

**Confirmed state:** Confirmed difference. Both screens inherit the same 16px horizontal inset from `Screen.tsx`. `chats.tsx`'s rows and search bar then add an _extra_ `spacing.lg` (16) on top, landing at 32px total. `wallet.tsx` adds no extra padding anywhere, landing flush at 16px.
**Refined spec:** Per your instruction ("use same margin padding used on the wallet screen") — remove the extra `paddingHorizontal: spacing.lg` from `ThreadRow` and the search-bar wrapper in `chats.tsx`, landing chat rows flush at `Screen`'s 16px, matching wallet exactly.

### A7. Chat list avatar size +0.3in, tap-to-preview

**Confirmed state:** `chats.tsx` renders a plain initials circle (44×44px hardcoded, not the shared `Avatar` component, no image support at all) — confirmed the shared `Avatar.tsx` component (built last session) is never imported here. The row's whole surface is one `Pressable` that always opens the thread; there's no separate avatar tap target, and **no action-sheet/bottom-sheet component exists anywhere in the app** to build a "Message / Profile" popup from.
**Refined spec:** Switch `ThreadRow` to the shared `Avatar` component (gets real photo support for free). 0.3in ≈ 48dp added → 44 + 48 = 92px (or express as a `theme/tokens.ts` size, e.g. add an `avatarLg` size token rather than a one-off literal). Give the avatar its own nested `Pressable` (stopping propagation to the row's own tap) that opens a small action sheet with "Message" / "Profile" — this needs a new lightweight, reusable `ActionSheet`/`BottomSheet` primitive in `components/ui/`, since none exists; build it as shared infra here rather than a one-off, since B3 (find-user) and future features will want the same pattern.
**Notes:** "View the dp" (profile photo) full-screen tap-through and a "Profile" screen destination both need to exist — confirm: does a per-user profile _screen_ exist today to link "Profile" to? (Not found in the investigation — likely needs a minimal read-only profile view, or this could point at a pared-down version of Settings' own profile section for another user. Flagging as a small sub-decision for when this batch is built, not blocking scoping.)

---

## Batch B — Chat screen core UX — ✅ fully shipped (PR #54 + PR #56)

### B1. No-chat-credit send flow — ✅ shipped (PR #54)

**Confirmed state:** Partially built, with a real bug. Server already returns a clean `402 insufficient_credit` (with `credits_required`/`credits_available`). But the client's generic error-transport layer has no `message` field to fall back to for this response shape, so **today a failed send due to low balance literally displays the string "Request failed with status 402"** in red text — not any human copy. No branch on `error.code` anywhere. No buy-credit CTA wired from a failed send. No draft/outbox/pending-send concept exists at all — a failed send just leaves the typed text sitting in the box.
**Refined spec:**

- Client catches `EdgeFunctionError` with `code === 'insufficient_credit'` specifically (not just rendering `.message`).
- Instead of an error, render a friendly inline prompt: _"Buy chat credit to start your conversation"_ + a button that opens `BuyCreditModal` (currently wallet-tab-only — needs to become reachable from the thread screen too, e.g. as a route param or a shared modal host).
- **Pending-until-funded send:** recommend keeping this **entirely client-local** — never touch server-side money logic for this (per CLAUDE.md rule #1, no financial logic lives client-side, and a server-side "pending send queue" would be new money-adjacent surface for no real benefit). Concretely: on a 402, keep the composed text in a small local "pending outbox" (one item, this thread), show it as a distinct pending bubble in the message list, and auto-retry the real send once `useWallets`' existing Realtime subscription reports `topup_credit` ≥ the required amount — no polling, reuses infrastructure that's already live.
- Client-side pre-send balance check (comparing typed word-count-derived cost against the already-fetched wallet balance) to catch the common case _before_ even calling the server — matches the "Low-balance warning" motion spec already documented in `docs/04-DESIGN-SYSTEM.md` but never implemented. Server remains authoritative regardless (this is a UX nicety, not the enforcement).

### B2. Chat screen header: avatar + name/phone + online/last-seen — ✅ fully shipped (avatar/phone-fallback: PR #54; online/last-seen: PR #56)

**Confirmed state:** Partially built. Title already shows the partner's `display_name` when available (falls back to literal "Chat" otherwise, not to their phone number). **No avatar renders in the header at all** (the shared `Avatar` component exists but isn't imported here). **No "saved contact name" concept exists** — there's no phonebook/contacts table; the name shown is simply the other user's own global `display_name`. **No online/last-seen mechanism exists anywhere, client or server** — `docs/05`'s presence-channel spec was explicitly never implemented (confirmed by the code's own comment).
**Refined spec:**

- Add the `Avatar` component to the header (small size, no ring — rings are a status-specific affordance).
- Title: `display_name` if set, else the phone number formatted for display (not the literal word "Chat") — a real, cheap fix.
- "Saved contact name" as literally described (a name **you** gave them, distinct from their own global profile name) requires Batch C's contacts integration to mean anything — without a device-contacts/phonebook concept, there's nothing to "save." Recommend: ship the phone-number-fallback now (cheap, real improvement), and revisit true per-viewer contact naming once Batch C lands.
- **Online/last-seen is a genuinely new feature, not a UI tweak** — needs either a Supabase Realtime Presence channel (ephemeral, matches the original `docs/05` spec, no new column) or a persisted `last_seen_at` column updated on a heartbeat/foreground-event (simpler, survives app restarts, but is a new schema field). Recommend Presence for "online now" (cheap, ephemeral, no schema change) plus a `users.last_seen_at` column for the "last seen HH:MM" text when not currently online — gated by the same privacy-toggle pattern `read_receipts_enabled` already establishes (a `last_seen_enabled` column, default on, same self-scoped RLS-grant precedent).

### B3. Find-user-by-phone screen → chat-row result, tap to open — ✅ shipped (PR #54)

**Confirmed state:** Partially built. A match is found and the user's name is shown, but only as plain text ("Found {name}") forcing the user through a mandatory first-message box before a thread is created — no avatar rendered (even though `avatar_url` is already fetched and sitting unused), no tap-to-open. Threads are only ever created lazily, inside `fn_send_message`, on the first real message — there's no standalone "start an empty thread" server call today.
**Refined spec:** Render the found user exactly like a `ThreadRow` (reusing Batch A7's now-updated component) with a real avatar. Tapping it navigates straight into `/thread/[id]` **using the recipient's user id, not a thread id** — the thread screen already needs to handle "no thread exists yet for this pair" gracefully as a natural side effect (first send creates it via the existing `fn_start_thread`-inside-`fn_send_message` path, no new backend surface needed). This is simpler and safer than adding a new "create empty thread" RPC.
**What actually shipped, revised during implementation:** a new `start-thread` Edge Function (thin, non-money wrapper around the existing `fn_start_thread`) turned out cleaner than the "let the thread screen cope with no-thread-yet" plan above — it avoids adding branching state (loading messages/header-info/mark-read all assume a real thread id) throughout an already-complex screen, in exchange for one small new endpoint in the same class as `mark-thread-read`/`set-thread-blocked`. Tapping the found user now calls it and navigates straight to the real thread id it returns.
**Notes:** Last-seen privacy gating for this screen only matters once B2's last-seen feature exists — sequence this after B2, or ship without last-seen info here initially and add it once B2 lands.

### B4. Send icon button + keyboard-avoiding composer — ✅ shipped (PR #54)

**Confirmed state:** Confirmed. Send is a bare `<Text>` with an `onPress`, not an icon or the app's own `Button` component (real inconsistency: the _other_ "Send" button, in the find-user first-message flow, already uses `Button`). Tap target has no explicit sizing — likely under the 44×44pt minimum this app's own design doc requires. `KeyboardAvoidingView` is present but its `behavior` is `undefined` on Android (RN's documented no-op) — **on Android the composer can still sit behind the keyboard today**; iOS has no `keyboardVerticalOffset` accounting for the header height either.
**Refined spec:** Real icon button (`Ionicons name="send"`, filled circle in `brandPrimary`, `textInverse` icon — matches the existing `Button` primary style), minimum 44×44pt hit area. Fix `KeyboardAvoidingView`: `behavior={Platform.select({ ios: 'padding', android: 'height' })}` (the standard RN cross-platform pattern) plus a correct `keyboardVerticalOffset` accounting for the header.

---

## Batch C — Contacts & discovery — ✅ C1 shipped (PR #62), needs a native build before it's live on-device

### C1. Device contacts sync with InvolveMe-user detection + Invite — ✅ shipped (PR #62)

**Confirmed state (pre-build):** Not built at all. No `expo-contacts` dependency, no contacts permission code, no batch phone-lookup (the one lookup Edge Function that exists, `find-user-by-phone`, is single-number only). There's an existing "Contacts" sub-tab on the Chats screen today, but it's an explicit, documented non-feature stub (renders "Not available yet.") — this batch is what would actually fill it in. A generic "Invite a friend" share-sheet action already exists in Settings (fixed message, not contacts-aware) and can be reused/extended rather than rebuilt.
**Refined spec:**

- New `expo-contacts` dependency + standard iOS/Android contacts-permission flow (ask on first use of this screen, not on app launch — platform best practice, avoids the "why does this app want my contacts" cold-open friction).
- New batch Edge Function (`find-users-by-phones` or similar) taking an array of normalized phone numbers, returning which match existing users — avoids N single-lookup round trips and avoids ever sending raw contact data anywhere except this one auth'd call.
- List device contacts split into two sections: "On InvolveMe" (tap → chat, reusing B3's chat-row-result pattern) and "Invite" (share-sheet deep link, per-contact — extends the existing `Share.share` call already in Settings rather than a new mechanism).
- **This needs `expo-contacts`, a new native module — not OTA-eligible.** Same category as the still-pending device-fingerprinting build from an earlier session. Worth bundling into one `eas build` together with Batch E's biometric module (also native) rather than two separate native builds — flagging this coordination opportunity now so it's a deliberate choice, not an accident.

**Shipped as designed above**, with one real API-surface correction found while building: this app's installed `expo-contacts` version (57.x, matched to Expo SDK 57) has **replaced** the classic `getContactsAsync`/`Fields`-array API the refined spec above implicitly assumed — that function now throws at runtime in this version, kept only as a deprecated `expo-contacts/legacy` shim. Built against the current class-based API instead: `Contact.getAllDetails([ContactField.FULL_NAME, ContactField.PHONES])` for the bulk read, `requestPermissionsAsync()` for the permission gate — found by reading the installed package's own `.d.ts` files rather than assuming an older tutorial's API surface was still current.

**⚠️ Not usable on-device yet — needs an `eas build`, which was NOT triggered by this work per this project's own "never build without explicit ask" rule.** `expo-contacts` is a native module; the existing OTA update channel can ship the JS/config side (already merged) but can't add a native module to an already-installed binary. The Contacts tab will render but the `expo-contacts` native calls will fail (or the module won't exist) until a real `eas build` ships a binary containing it. Per the original spec's own note, consider bundling this into the same build as Batch E's biometric module (also native) rather than two separate native builds — hold both features' native work until there's a deliberate "build now" decision.

---

## Batch D — Wallet transaction history restructuring — ✅ shipped (PR #52)

### D1. Per-user chat transaction history + separate bought/sent-credit toggle

**Confirmed state:** Today's transaction history is one flat, ungrouped, unfiltered list of every `ledger_entries` reason mixed together (topups, message debits, earnings, withdrawals, transfers, status posts — everything). Schema fact that matters: `ledger_entries` has **no direct counterparty column**. Reasons split three ways:

- **Traceable to a counterparty, 1-hop** (already has the FK): `credit_transfer_sent/received/conversion/platform_cut` → `credit_transfers.sender_id/recipient_id` directly.
- **Traceable to a counterparty, 2-hop** (needs a join): `message_debit`, `escrow_*` → `ref_id` → `messages.id` → `messages.thread_id` → `threads.participant_a/b`.
- **No counterparty at all**: `topup_purchase`, `withdrawal_*`, `status_upload_debit`, `manual_adjustment`, `platform_reserve_skim`, `chargeback_*` — these are exactly the "bought/sent credit" bucket the toggle needs to isolate.
  **Refined spec:** Two views, matching the two hops above and mirroring the existing `thread_unread_counts` pattern (a `security_invoker` view so RLS still does the real access control):

1. A "chat transactions" view/query joining `ledger_entries` → `messages`/`threads` (and unioning in `credit_transfer_*` rows, which already carry the counterparty directly) grouped by counterparty user, newest activity first.
2. The existing flat `useLedgerEntries` query, filtered to the no-counterparty reason set, becomes the "bought/sent credit" tab.
   A simple two-way toggle/segmented control atop the existing `TransactionHistory` component switches between them; tapping a grouped counterparty row expands/loads that person's history.
   **Notes:** No new schema needed — this is query/view-layer work, but the join needs its own composite index (`ledger_entries(ref_type, ref_id)` already exists and is the right one to join through; no new index required, just a query that uses it, per the investigation).

---

## Batch E — Auth hardening + onboarding — E1 shipped (PR #64), needs a native build before it's live on-device

### E1. Verify-once-per-device, then biometric/PIN — ✅ shipped (PR #64)

**Confirmed state (pre-build) — one correction to the original report:** "every sign-in goes through phone entry + fresh OTP" turned out **not accurate** on closer reading of the actual code, not just the original bug report — `lib/supabase.ts` already configures `persistSession: true`/`autoRefreshToken: true` on AsyncStorage, and `app/_layout.tsx`'s auth gate redirects straight to `/(tabs)/chats` whenever `useSession()` resolves an existing session, with the phone/OTP screens never rendered in that case. **The "verify-once-per-device" behavior this item asks for already existed** via Supabase's own session persistence — what was actually missing, confirmed by grepping for `expo-local-authentication` (zero references) and any biometric/PIN code (none), was only the hardening layer in front of that already-persisted session: nothing gated access to a still-valid session behind anything beyond the OS having launched the app at all.
**Refined spec (industry-standard pattern, e.g. WhatsApp/Signal/most fintech apps):** OTP only on first verification per device (already true). After that, gate access to the already-valid, already-persisted session behind the **device's own OS-level biometric/passcode** via `expo-local-authentication` (Face ID / Touch ID / Android biometric / device passcode fallback — never a custom in-app PIN screen, which would be weaker and more code to secure than just delegating to the OS lock the device already has). No new server-side auth concept needed — this is purely a client-side "unlock to use the already-valid session" gate. New native module — not OTA-eligible (bundle into the same `eas build` as C1/device-fingerprinting per the note above).
**Notes:** Needs a documented fallback for devices with no biometric enrolled (fall back to full OTP re-verification, don't lock the user out) and a decision on re-auth timing (e.g., require the biometric check once per app foreground, not once per screen).

**Shipped as `lib/appLock.ts`'s `useAppLock` hook** (AppState-driven, same pattern `lib/lastSeen.ts` established for a different purpose) + a full-screen `AppLockScreen`, gating the entire `<Stack>` in `app/_layout.tsx` whenever locked. Two scoping decisions made while building, both documented inline in the code:

- **No-biometric-enrolled fallback:** the Notes line above floated "fall back to full OTP re-verification" — not what shipped. A device with `SecurityLevel.NONE` (no biometric **and** no passcode set at all) skips the gate entirely instead, since "delegate to whatever lock the device already has" has nothing to delegate to in that case, and re-triggering OTP would reintroduce the server round-trip the same spec's own "purely client-side, no new server-side auth concept" line says isn't needed. A device with a passcode but no biometric still gets gated (`authenticateAsync` falls back to the OS passcode prompt natively).
- **Re-foreground race guard:** the biometric system sheet itself briefly backgrounds the app on both platforms, which fires the same `AppState` "active" transition a real user switching back to InvolveMe does — without a guard, a successful unlock could immediately self-re-lock. Added a 1.5s grace window after a successful unlock before another foreground transition is allowed to re-trigger the check. **Untested on a real device or simulator** (none available in this sandbox) — the timing was chosen defensively, not measured; worth a real-device pass before trusting it under real Face ID/Touch ID latency.

**⚠️ Not usable on-device yet — same native-build gap as C1.** `expo-local-authentication` is a native module; the OTA-eligible JS/config side is merged, but the actual gate needs a real `eas build` to exist as a native call at all. No build was triggered by this work. Batch E's own original note already flagged bundling this with C1's `expo-contacts` into one deliberate build rather than two — now there are two real candidates waiting on that same decision.

### E2. First-signup onboarding: country code (default +234) → country → full name → nickname → currency auto-detect → animated welcome

**Confirmed state:** Not built at all. A brand-new user goes phone entry → OTP → directly to the chats list. No onboarding route exists. `users` has no `country`/`country_code`/`currency`/`nickname` columns — only `display_name` (populated later, only via Settings) and `phone`. "Unnamed" is a client-side rendering fallback for _other_ users with no name, not something ever written to a new user's own row. Phone entry is currently Nigeria-only hardcoded (`toE164NigerianPhone`).
**Refined spec:** New `(auth)/onboarding` route, shown once, right after first-ever OTP verify (detect "first time" via `users.display_name is null`, the natural signal already available — no new flag needed):

1. Country code picker for the phone step itself (defaulting to `+234`, per CLAUDE.md's own "NGN-only for now" posture — this generalizes the phone-entry screen, not just onboarding).
2. Country selection (new `users.country` column).
3. Full name (writes `users.display_name` — replacing today's "set it later in Settings, defaults to nothing" flow).
4. Nickname (new `users.nickname` column — the "may wish to show publicly" field, distinct from full name).
5. Currency auto-detected from the selected country (new `users.currency` column) — **confirmed: functionally currency-aware from day one, not just data collection.** This folds the "Multi-currency support" explicit-build item (below) into this batch's real scope rather than deferring it — `pricing_config` needs a per-currency rate/unit-price dimension, `packages/payments/` needs to know which provider/rail serves a given currency (Flutterwave is NGN-first; a non-NGN signup needs either a different collection rail or an honest "not supported yet, NGN only" fallback at signup for currencies with no live provider), and every kobo-denominated amount in the ledger needs a currency tag so conversion/display is correct per user. This is a materially larger effort than the rest of this batch — **recommend scoping and building it as its own dedicated sub-effort inside Batch E, sequenced after E1 (auth hardening) ships, not bundled into the same PR** — auth hardening and full multi-currency onboarding are both substantial on their own and shouldn't compete for review attention in one diff.
6. Animated welcome screen (chat/laughter emoji motif, matching `docs/04`'s existing playful-but-clean tone) → lands on chats.

---

## Batch F — Status feature: full story experience

The biggest single item on this list. Hard prerequisite: **a real Storage/media upload pipeline does not exist anywhere in this app** — this has been named as a gap in every session that's touched status so far, and photo status can't ship without solving it. Scoping this batch means scoping the pipeline too, not deferring it further.

**Confirmed current state (post-merge, this repo, right now):** composer is a plain text box + post button — no template/style picker. Viewing opens a small centered modal dialog (not full-screen), listing captions in a static scrollable list — no per-item timing, no auto-advance. Text-caption only; `media_url` is plumbed through the backend and the type but never populated or rendered client-side. No view-count display anywhere (only a binary seen/unseen flag is computed). No delete capability — no DELETE RLS policy, no function, nothing. No swipe-between-posters gesture — the viewer only ever shows one poster at a time with a Close button.

**Refined spec, best-practice story UX (matching the WhatsApp/Instagram-class pattern you referenced):**

1. **Storage pipeline** (prerequisite): Supabase Storage bucket for status media, signed upload URLs issued by a new Edge Function (never a client-side direct-to-bucket credential), image compression/resizing client-side before upload (this app's own "stay lite" / no-full-resolution-media-by-default rule, `docs/01-ARCHITECTURE.md`).
2. **Composer:** full-screen, camera-first (matches `docs/04`'s own already-documented IA note — "camera-first composer" was the intent from the start), with a small set of clean background/text-style templates for text-only posts (a fixed palette from the design tokens, not a free-color picker — keeps it "clean and modern" without ballooning scope).
3. **Full-screen story viewer:** each status item displays full-screen with a per-item progress timer (**6 seconds per item, confirmed**), auto-advancing to the poster's next item, then closing/returning to the feed.
4. **View count:** visible to the poster only, on their own status (tap to see a number now; a full viewer-list is a natural later add-on, not required to ship this). Needs a `count`-style query against `status_views` (the table exists, it's just never aggregated today).
5. **Delete:** new RLS DELETE policy (own rows only) + a thin client action — no new function needed, a direct RLS-scoped delete is safe here since it's a pure self-serve delete of your own content, not a money-adjacent write.
6. **Swipe-through:** from the "Recent updates" row, swiping horizontally in the full-screen viewer moves to the next contact's story set, matching the reference apps' pattern — the current "one poster per modal open" structure gets replaced by a single full-screen viewer that can page between posters.
7. Photo viewing: full-screen for both the poster (reviewing their own post) and viewers (tapping to view), reusing the same full-screen viewer component as the story playback.

---

## Batch G — Push notifications — ✅ fully shipped (PR #58 + PR #59 + PR #61), split into 3 parts

**Confirmed state — important correction to the original report:** the Settings toggle is **not actually broken in the code** — it's correctly wired (`usePushEnabled`/`useSetPushEnabled` read and write the same query key, the mutation correctly registers/unregisters the device's Expo push token, and error states for denied/unsupported/error are all handled with real user-facing alerts). New-message push is also genuinely, fully wired end-to-end (token → `send-message` → real call to Expo's push API) — this is not scaffolding-only. **Before scoping a "fix," we should reproduce what you're actually seeing** — a toggle that visually doesn't move is more likely an OS-level permission denial (which the code already has a branch for, showing an alert) or a specific device/simulator quirk than a code bug. Recommend a quick real-device repro pass at the start of this batch rather than guessing at a fix blind.

What **is** confirmed genuinely missing, independent of the toggle question:

- Every other event (credit received, top-up confirmed, withdrawal completed, the already-documented-but-never-built "no bank account" reminder) sends no push today — only new messages do.
- No mute concept exists anywhere (no per-thread or global mute column/table/check).

**Refined spec:**

1. Reproduce the toggle issue on a real device first (5 minutes, before writing any code) — confirm whether it's a real bug or an OS-permission-denied state that's actually working as designed. Deferred: no code bug was found in the initial investigation (the toggle is correctly wired end-to-end), so this stayed a "watch for it" item rather than a blocking repro step.
2. Extend `sendPushToUser` calls to the other real events (transfer-credit received, topup confirmed, withdrawal completed) — same pattern already proven in `send-message`, just wired into three more Edge Functions. — **✅ shipped (PR #58)**: `webhook-flutterwave`, `reconcile-topups`, `check-topup-status`, and `transfer-credit` all now fire a real push on their respective success paths, via new `notifyTopupConfirmed`/`notifyWithdrawalCompleted` helpers in `_shared/push.ts`.
3. Build the auto-sweep-reminder push that's been documented-but-unbuilt since it was first scoped. — **✅ shipped (PR #61)**: `remind-no-bank-account` (new pg_cron → Edge Function job, every 6h, mirroring `reconcile-topups`' pg_net/Vault wiring) sends the three escalating pushes docs/06 §5 actually specifies (24h/48h/72h, tracked via `users.withdrawal_reminder_last_milestone_hours`), targeting the same withdrawable_cash-with-no-verified-bank-account set auto-sweep's own inner join already excludes. The in-app "persistent banner" half of §5 was already covered by wallet.tsx's always-visible "Add bank account" action — nothing new needed there. Also fixed forward: docs/05's scheduled-jobs table previously claimed `auto-withdraw-sweep` itself sent this reminder, which it never did — corrected alongside this PR.
4. Add mute: a `threads.muted_by_a`/`muted_by_b`-style pair (mirroring the existing `blocked_by`/read-cursor column pattern already established for per-participant thread state) checked before `sendPushToUser` fires for that thread, plus a global "mute all" fallback in Settings for completeness. — **✅ shipped (PR #59)**: per-thread mute (`fn_set_thread_muted`, `set-thread-muted` Edge Function, overflow-menu toggle, `send-message` gate). The global "mute all" fallback was scoped as a nice-to-have, not required to close this item — held for a later pass since per-thread mute alone covers the reported need.

---

## Recommended build order

Each batch is its own PR — built, tested, then merged — only starting on your explicit go-ahead per batch, per your instruction. Suggested order (dependency- and risk-aware, not mandatory):

1. **Batch A** — theme/layout foundation (no schema, no new deps, fixes visual issues every later batch benefits from)
2. **Batch D** — wallet transaction grouping (fully independent, self-contained, safe to slot anywhere)
3. **Batch B** — chat screen core UX (builds on A's header fix)
4. **Batch G** — push notifications (independent; start with the 5-minute repro)
5. **Batch C** — contacts & discovery (new native module — coordinate with E's native module into one `eas build`)
6. **Batch E** — auth hardening + onboarding (new native module; bundle the build with C)
7. **Batch F** — status story overhaul (biggest scope, needs the storage pipeline; last so the smaller batches de-risk the patterns first)

---

## Explicit builds — scoped for your separate review, not part of the batch order above

### Group chats

**Confirmed state:** Already built, further along than the others on this list. Schema (`20260913200000_group_chats.sql`), `fn_send_group_message`, and full test coverage (`group-chat-functions.test.js`, 19/19) all exist. Held behind `pricing_config.group_chat_enabled = 0` (a real kill switch, not just a comment) pending Phase 5's fraud infra existing. **That infra now exists** — collusion detection, topup velocity limits, and duplicate-content/rate-limiting all shipped in sessions 13–15, which is exactly what this feature's own gating condition named as the prerequisite. Scoping this item is really a go/no-go review (re-verify the fraud infra genuinely covers group-chat's specific risk shape — no reply-gate, no per-message cap on a 70/30 instant-settlement model) plus flipping the switch, not new engineering.

### End-to-end encryption

**Confirmed state:** Not built; explicitly deferred with an honest-disclosure requirement in the interim (`docs/07-COMPLIANCE-LEGAL.md` §5: "must be disclosed honestly... don't imply E2EE unless it's actually built" — already done, the drafted Privacy Policy discloses this). This is a large, cross-cutting lift: real E2EE would need client-side key management, multi-device key sync, and — critically — would break server-side content moderation, which currently reads plaintext message bodies (`docs/06` content-moderation pipeline). Scoping this properly means resolving that product tension (E2EE vs. moderation) before any code, not just picking a crypto library.

### Credit resale/gifting + referral bonuses

**Confirmed state:** No referral system exists at all. Note: peer-to-peer credit **transfer** (`fn_transfer_credit`) already ships live today — before scoping "credit resale/gifting" as new work, worth confirming with you whether that's already the feature you mean, or something distinct (e.g., a secondary marketplace for reselling credit at a markup, which is a materially different — and more regulatorily sensitive — thing than the direct-transfer-at-face-value feature already built). Referral bonuses specifically are explicitly gated behind full fraud-infra maturity per `docs/06` §10 (OTP/carrier-detection prerequisites still don't exist, separate from the collusion/velocity infra that's already done).

### Multi-currency support — **absorbed into Batch E** (no longer a separate later item)

Per your decision that onboarding's currency step should be functionally currency-aware from day one, this is no longer a separately-deferred effort — see Batch E's E2 spec above for the real scope (per-currency `pricing_config`, payment-provider-per-currency routing, ledger currency-tagging). Still worth noting: `docs/01-ARCHITECTURE.md` already flagged multi-currency as a "peel into a dedicated service" scale concern, and KYC vendor coverage (Prembly) and the CBN money-transmission regulatory posture (`docs/07` §1) are both Nigeria-specific today — a non-NGN user signing up raises real KYC/regulatory questions this scope needs to answer, not just a payments-routing one. Recommend resolving those two questions explicitly before writing the Batch E currency sub-effort's implementation plan.

### Voice/video calls (10 credits/min video, 5 credits/min audio)

**Confirmed state:** Not built at all — no signaling infrastructure, no `calls` schema, no pricing_config keys, and the roadmap explicitly held this pending a monetization decision (now provided). This is arguably the single largest item on this entire list. A real scope needs: a WebRTC/managed-calling-provider decision (e.g. a service like Agora/Twilio/Daily vs. self-hosted signaling — this app's own "stay lite" posture argues strongly for a managed provider rather than building signaling infrastructure from scratch), a genuinely new billing shape (per-minute metering is fundamentally different from per-message escrow — needs a "start call" hold, periodic debit while connected, graceful handling of drops/disconnects, minimum billable increments), new fraud considerations (call-farming as an analogue to message-farming), and background/foreground call-handling + push-triggered ringing on both platforms. Recommend this get its own dedicated design pass (like group chats got in an earlier session) before any implementation estimate is meaningful.

---

## Kept for later (not in this pass, not forgotten)

- Media/Storage pipeline as a **standalone** later item is superseded — it's now a hard prerequisite inside Batch F, not separately deferrable.
- Apple pre-submission review notes (writing task, no code).
- The held `eas build` for device-fingerprinting's native modules — now explicitly worth bundling with Batches C and E's own new native modules into one build.
- Test-suite concurrency fix (hygiene, unscheduled).
- §11 legal sign-off (needs counsel, not code).
