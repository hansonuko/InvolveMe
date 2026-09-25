# 17 — Voice Notes (Audio Chat Messages): Scoping

Scoping only, per explicit instruction — nothing in this document is built yet. Read `docs/03-ECONOMY-LEDGER.md` and `docs/06-SECURITY-FRAUD-LOOPHOLES.md` before implementing any of it (CLAUDE.md standing rule).

**Revision history:** v1 of this doc scoped a minimal (tap-to-record, flat playback) version. Explicit correction from the user: target **full WhatsApp interaction parity** — hold-to-record with slide-to-cancel/slide-to-lock, a real (not decorative) waveform, scrub/speed/auto-advance playback, contextual mic↔send icon — rescoped against this project's actual architecture and its own hard-won lessons (a real production crash from a prior gesture feature, see §4). This version supersedes v1 entirely.

## 1. What "100% WhatsApp-like" concretely means (the target UX, unabridged)

**Recording (composer, mic side):**

- Composer's trailing icon is contextual: **mic when the text field is empty, paper-plane send icon the instant any text is typed** — not two separate buttons.
- **Press-and-hold the mic to start recording**, not tap-to-toggle. Releasing over the mic's own position **sends** the note. Releasing after **sliding left** past a cancel threshold **discards** it (no message, no charge, no upload). Releasing after **sliding up** past a lock threshold **locks** recording hands-free — the finger can lift, recording keeps running, UI switches to a locked toolbar (send / delete-trash / a pause-resume toggle for locked recording, matching WhatsApp's own newer behavior) and the user taps to finish.
- **Live timer** (mm:ss, counting up) and a **live animated amplitude visualizer** reacting to real mic input in both the held and locked states — not a looping decorative animation.
- A **"slide to cancel ◁"** hint that visually fades/tracks the drag.

**Sent bubble (playback side):**

- A **real waveform**, generated from the actual recording's amplitude, not a random/looping placeholder — this is the single most recognizable visual element of a WhatsApp voice note and the detail most likely to look wrong if faked.
- Tap to **play/pause**; **tap/drag along the waveform to scrub**; a small circular "playhead" indicator moves along the waveform during playback.
- **Speed control** (1x → 1.5x → 2x, cycling on tap), shown once playback has started.
- **One voice note plays at a time** in the app — starting a new one stops whatever else is playing.
- **Auto-advance**: when a voice note finishes, the next consecutive voice note further down the same thread starts automatically (a real WhatsApp behavior, not incidental).
- **Unplayed indicator** (a small dot) on a received note until the recipient has actually played it at least once — independent of the existing text read-receipt (double-tick) system, which still applies to delivery/read status the same as any other message.
- Plays through the device's normal media output, including **respecting silent/mute switch behavior the way a media app does** (a real per-platform audio-session config item, not automatic — see §7).

Everything in this section is UI/UX. None of it is a billing or trust decision — those are §§3–5, unchanged in spirit from v1 but re-verified against this fuller feature set.

## 2. Baseline audited (ground truth, unchanged from v1, restated for completeness)

- **`docs/16-CHAT-MEDIA-SCOPING.md` already deferred voice notes explicitly** ("its own scoping pass if wanted") — this doc is that pass.
- **The chat-photo pipeline (session 33, live) is still the correct backend precedent**: `messages.media_path`/`media_type` (currently hard-constrained to exactly `'image'` in `fn_send_message`), a private `chat-media` bucket with **no client INSERT policy at all**, `create-chat-media-upload-url` (currently hardcodes `.jpg`, mints for `chat-media` only), path-prefix + Storage-existence validation inside `fn_send_message` before any charge or row insert, an additive flat `message_media_credits` surcharge, `fn_delete_message_for_everyone` cleaning up the real Storage object. All of it extends, not forks, for audio.
- **This app's chat client is React Native (Expo SDK 57), not a browser** — no `MediaRecorder`. The real equivalent, `expo-audio`, is **not currently installed** → a genuine new native dependency → a real `eas build`, not an OTA update. Needs an explicit go-ahead before any client work starts (memory: `no-unprompted-eas-builds`).
- **Unrelated to `docs/11-VOICE-VIDEO-CALLS-SCOPING.md`** (real-time calls, LiveKit, not started) — zero shared infrastructure with recorded voice-note messages.
- **No audio moderation exists anywhere in this codebase** today (`packages/moderation`'s `ContentModerationProvider` covers text and, as of session 33, images only).

## 3. Pricing — still config-driven, server-computed, still flat for v1 (CLAUDE.md rules #1/#9)

WhatsApp itself is free, so "100% WhatsApp-like" has no pricing precedent to copy — this stays this app's own design call, made the same way every other price in this codebase is made: config, not a constant, computed inside `fn_send_message`.

```
credits_charged = message_base_credits × max(word_blocks, 1)   // unchanged — an optional caption still bills as text
                 + (has_audio ? message_audio_credits : 0)      // new, own pricing_config key
```

- **Own key (`message_audio_credits`), not a reuse of `message_media_credits`** — a voice note is a different average payload and perceived value than a photo; product/ops should be able to move the two independently, same reasoning that justified `message_media_credits` existing as its own key in the first place.
- **Flat, not duration-tiered, for v1.** Duration-tiered pricing would require trusting a client-reported duration for billing (the same "not a client-supplied value taken on faith" issue path validation already solves for `media_path`), and is materially more build (accrual-style logic where every other message is a single compute-once-debit-once event, the exact contrast `docs/11` §1 draws for calls). Flat pricing sidesteps the whole trust question. Revisit only if there's a real product signal that length-based pricing is wanted — not built speculatively.
- **Max duration cap enforced server-side, not just client UX** — flat pricing removes the "underpay for length" exploit but not "impose unbounded storage/bandwidth cost for a fixed charge." Recommend a real ceiling (config key, e.g. `message_audio_max_seconds`), generous enough to feel like WhatsApp (WhatsApp doesn't meaningfully cap short/medium notes) but bounded — a few minutes, product's call on the exact number, enforced inside `fn_send_message` the same way `message_max_words` gates text today. The client-side auto-stop-at-cap is UX only, never the actual gate.
- **Editing:** media (photo or audio) stays non-addable/non-removable on edit, same decision `docs/16` §3 made and the same reasoning (matches WhatsApp: you can't turn a sent message into a voice note after the fact).

## 4. The real implementation risk this feature specifically reintroduces: gesture handling

This is new context v1 of this doc didn't have and it materially changes how §1's interaction gets built, so it's called out on its own.

**This codebase has already shipped and then reverted a gesture feature in this exact chat surface, in production**, for a documented, specific reason: `fix(mobile): remove swipe-to-reply gesture — real production crash on opening chat (#117)`. Root cause (from that commit's own message): a fresh, un-memoized `Gesture.Pan()` object was constructed on every render of every message bubble inside the thread's `FlatList` — the first place this app combined `react-native-gesture-handler`'s Gesture API with a Reanimated shared value, and a documented correctness hazard for that combination (gesture objects must be memoized). It shipped past lint/typecheck/review and only surfaced as a live "Maximum update depth exceeded" crash on a real device.

**Why the hold/slide/lock recorder gesture (§1) is not the same failure shape, but deserves the same caution:**

- The prior crash came from **one gesture object per FlatList row**, multiplied across every rendered message. The recorder gesture lives on **one fixed composer button**, not a per-item list element — the specific multiplication bug can't recur in the same form.
- It is still the **second real place** in this app combining `Gesture.Pan()` with Reanimated shared values (both libraries are already compiled into the current build and used successfully elsewhere — e.g. `StoryViewer`'s hold-to-pause — so this isn't a new native dependency, just new gesture _logic_). The lesson to actually carry forward isn't "avoid gestures," it's the concrete rule the postmortem names: **memoize the gesture object** (`useMemo`/built once, not reconstructed per render) and keep callback refs stable — and **verify it live on a real device before shipping**, the same discipline that incident's own writeup wishes had been there the first time, since this bug class passed lint/typecheck/code review cleanly.
- **Recommendation: build it, don't downgrade to tap-to-toggle** — the hold/slide/cancel/lock interaction is core to what makes a voice-note feature actually feel like WhatsApp, and a tap-to-start/tap-to-stop fallback would be a visible, immediately-noticed downgrade. Build it as a single, deliberately isolated component (one memoized `Gesture.Pan()` on the record button, state machine for idle/recording/locked/cancelling kept explicit and simple), and treat "confirmed working on a real device, not just simulator/typecheck" as a hard exit criterion for this piece specifically — not optional polish, given this app's own history with exactly this bug class.

## 5. Real waveform, not decorative — data model consequence

WhatsApp's waveform is generated from the actual recording. Faking it (random bars, a looping placeholder) would be an immediately visible tell and isn't "100% parity." The lite, dependency-free way to get a real waveform in this stack:

- **Sample amplitude client-side while recording**, using `expo-audio`'s live metering (the same signal driving §1's live recording visualizer) polled at a fixed interval (e.g. every ~60–100ms), producing a small array of normalized amplitude values (e.g. ~40–60 samples covering the whole note, downsampled/bucketed if the recording runs long). This avoids ever decoding audio (expensive, and this app has no audio-processing infrastructure) either client-side on playback or server-side — the bubble just renders the array it already has.
- **New column**: `messages.waveform_samples` (a small bounded numeric array, e.g. `smallint[]`, values 0–100). Nullable, audio-only, additive migration — same shape as `duration_seconds`.
- **A real, if minor, loophole to close in `fn_send_message`**: this is a new client-supplied array parameter that isn't financial, but is still untrusted input — **cap both array length and value range server-side** (e.g. reject anything over a fixed max element count or out-of-range values) before insert, the same "don't take a client-supplied value on faith" posture applied everywhere else, just for a storage/integrity reason (an unbounded array is a cheap row-bloat/minor-DoS vector) rather than a monetary one.
- `duration_seconds` stays as scoped in v1 of this doc: **display-only, not read by billing logic** (§3).

## 6. Moderation

Unchanged conclusion from v1, restated: no audio-moderation path exists today. Two real options:

1. **Transcribe, then run the transcript through the existing `moderateText`** — reuses the already-integrated OpenAI moderation call, at the cost of a transcription step (e.g. Whisper) newly added to the send path. Catches spoken content; doesn't catch non-speech audio abuse — a real, stated gap, not a silent one.
2. **Ship unmoderated at launch**, flagged for legal review same as CLAUDE.md's compliance posture requires for any unmoderated content path.

**Recommend (1) before general availability** — matches how this app actually handled the same decision for images (built in the same session as the rest of the pipeline, not deferred indefinitely).

## 7. Platform-specific playback behavior (new in this revision — real, not cosmetic)

"Plays like WhatsApp" includes **how it plays**, not just how it looks:

- iOS: voice notes should audibly play through the device speaker **even when the physical silent switch is on** (the same behavior every real media/messaging app uses) — this requires an explicit `AVAudioSession` category configuration (`playback`, not the default `ambient`) at the native-config layer, a real, easy-to-miss detail if left at whatever `expo-audio`'s default is. Confirm the exact config live before shipping, don't assume the default matches.
- **One-global-player invariant** (§1): needs a single shared playback controller (not one `Audio.Player` instance improvised per bubble) so starting note B reliably stops note A — a small, real piece of shared state, not automatic from rendering bubbles independently.
- **Auto-advance** (§1) is a thin behavior on top of the same shared controller: on "finished," look up the next audio message below the current one in the already-loaded thread list and start it — no new server call, purely client-side sequencing.

## 8. Storage & schema design

- **Bucket:** extend `chat-media` (add the confirmed audio MIME type to `allowed_mime_types`; confirm the exact string `expo-audio` actually produces — likely an `.m4a`/AAC container — live before writing it into the migration, not assumed) rather than standing up a second bucket. One bucket, one RLS predicate to reason about for "who can read this thread's attachments."
- **`fn_send_message`**: widen the `media_type` check from `is distinct from 'image'` to an allow-list (`'image'`, `'audio'`); accept `p_waveform_samples` (bounded, §5) and reuse the existing `duration_seconds`-shaped column addition from v1.
- **`create-chat-media-upload-url`**: extend with a `kind: 'image' | 'audio'` parameter driving file extension and any per-kind size ceiling, rather than a second near-duplicate function.
- **RLS**: the existing `chat_media_select_visible`/`chat_media_delete_own` policies key on bucket + path prefix, not file type — confirm live that they already cover audio objects in the same bucket without a new policy (expected, but verify, don't assume).
- **Played indicator** (§1): a nullable `messages.audio_played_at timestamptz`, set once by the recipient's client the first time playback starts — a lightweight read-state signal parallel to (not replacing) the existing message read-receipt system, no escrow/billing relevance, cheap enough to include for real parity rather than fake with local-only state given this app has no cross-device sync yet to complicate it.

## 9. Forwarding — a consistency call, not a special case

WhatsApp supports forwarding voice notes. This app's `ForwardMessageModal` **only carries `body` today — it doesn't support forwarding photos either**, per `docs/16`'s own explicit v1 exclusion. Recommend: **don't build audio-specific forwarding ahead of photo forwarding** — that would leave photos (already shipped) behind audio (not yet shipped) for no reason. If forwarding attachments is wanted for full parity, scope it once, generically ("extend `ForwardMessageModal` to carry any attachment"), covering both media types together, as its own follow-up pass — not bolted onto this feature first.

## 10. Client pipeline

1. **`expo-audio`** (new dependency, §2 — confirm current SDK-57-compatible version live) for record/pause/resume/stop + live metering (drives both §1's recording visualizer and §5's waveform sampling) + playback with variable rate (needed for the 1x/1.5x/2x control).
2. Recorder component: single memoized `Gesture.Pan()` (§4) on the composer's mic button, explicit state machine (idle → recording → locked | cancelling → sent/discarded), live timer, live amplitude bars, slide-to-cancel/slide-to-lock thresholds tuned to feel right on a real device (not just numerically reasonable).
3. Mic-permission request wrapped in `withAppLockSuppressed` (`lib/appLock.ts`), same bracket every other system-dialog prompt in this app already uses.
4. On send: call the extended `create-chat-media-upload-url` (`kind: 'audio'`), upload via `uploadToSignedUrl` (same RN `Blob`-polyfill caveat the photo client code already documents — `.type` on the Blob is what matters, not `fileOptions.contentType`), then `fn_send_message` with `media_path`/`media_type`/`duration_seconds`/`waveform_samples`.
5. Optimistic bubble: the locally-recorded note is immediately playable while the send is in flight, swapped for the server row once it lands — same treatment text/photo sends already get.
6. `MessageBubble` audio branch: waveform render from `waveform_samples`, play/pause/scrub/speed controls wired to the shared global player (§7), unplayed dot until `audio_played_at` is set, auto-advance on finish.
7. Failure/offline handling: upload failure gets a real retry affordance (matches photo); offline sends are rejected with a clear error, not silently queued (this app's outbox has no re-upload-a-local-file concept, matches the photo pipeline's own decision).

## 11. Build order

1. **Confirm the `eas build` go-ahead** (§2) — the one hard blocker nothing else here had. Nothing client-side ships without it; everything else can be built/reviewed independently.
2. Migration: `media_type` allow-list widened, `duration_seconds` + `waveform_samples` + `audio_played_at` columns, bucket MIME type widened, `message_audio_credits`/`message_audio_max_seconds` pricing_config keys.
3. `create-chat-media-upload-url` extended for `kind: 'audio'` + test.
4. `fn_send_message` audio support: billing, max-duration enforcement, waveform-array bounds check (§5) + test (ledger-conservation + concurrency, per CLAUDE.md's mandate).
5. `fn_delete_message_for_everyone` — confirm it already generically clears media fields regardless of type (should, from the photo build); extend only if it isn't generic.
6. Moderation (§6) — recommended before general availability, not blocking the rest.
7. Client: recorder gesture component (built and **device-verified in isolation before it's wired into the real composer**, given §4), shared playback controller, bubble UI — gated on step 1.

## Decisions for your call (the things this doc can't settle on its own)

- **`eas build` authorization and timing** — the real blocker; nothing client-side proceeds without an explicit yes.
- **Accept the hold/slide/lock gesture build (§4) as scoped**, given this app's own prior incident in the same area — recommended (a tap-to-toggle fallback would be a visible downgrade from "100% WhatsApp"), but worth a conscious yes given the history.
- **`message_audio_credits` value and `message_audio_max_seconds` cap** — product/pricing numbers, not decided here.
- **Moderation timing** — build `moderateAudio`-via-transcription before general availability (recommended) vs. ship unmoderated behind a flag first.
- **Forwarding** — deferred, bundled with photo forwarding later as one pass (recommended), rather than built audio-first.

Nothing in this document is built. Say go and name which of the above you want settled before I start, or accept the recommendations as written and I'll proceed in the build order above.
