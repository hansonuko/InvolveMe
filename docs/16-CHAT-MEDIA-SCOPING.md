# 16 — Chat Media (Photo/Video) Scoping

Scoping only, per explicit instruction — nothing in this document is built yet. Read `docs/03-ECONOMY-LEDGER.md` and `docs/06-SECURITY-FRAUD-LOOPHOLES.md` before implementing any of it (CLAUDE.md standing rule).

## 1. Baseline audited before designing anything (ground truth, not assumption)

- **Chat has no media pipeline of any kind today.** `docs/03-ECONOMY-LEDGER.md` §7 says so explicitly ("chat media has no pipeline of any kind yet... the two [status and chat media] are unrelated, independently-scoped pieces of work"). `messages` has no media column; `MessageBubble` (`apps/mobile/app/thread/[id].tsx`) only ever renders `message.body` as text.
- **A real, working precedent already exists: the status-media pipeline** (`docs/02-DATA-MODEL.md` §10, `20260917140000_status_media_pipeline.sql`, `apps/mobile/lib/queries/status.ts`'s `useCreateStatusUploadUrl`/`uploadStatusMedia`/`useStatusMediaUrl`). This scoping deliberately mirrors its shape everywhere it applies, rather than inventing a second pattern for the same problem:
  - Private Storage bucket, no direct client write — only a server-minted **signed upload URL** (Edge Function, service role) authorizes an upload; there is deliberately no `INSERT` policy for `authenticated` on the bucket.
  - Reads via `createSignedUrl`, gated by a `storage.objects` SELECT RLS policy that re-derives the same visibility condition the owning table's own RLS already encodes.
  - Client-side resize/compress _before_ upload (status uses `expo-image-manipulator` → JPEG; `docs/01-ARCHITECTURE.md` §5's chat-image target is **max 1600px longest edge, WebP**, an aspirational budget line that's never been implemented — this is the first real occasion to implement it).
  - Delete only through the real Storage REST API (`.remove()`), never raw SQL `DELETE FROM storage.objects` — confirmed hard-blocked at the platform level regardless of role/RLS (`docs/02-DATA-MODEL.md` §10's own note, and directly relevant to this session's `expire-statuses` function, which uses `.remove()` for exactly this reason).
- **Status media is deliberately photo-only, no video** — "stay lite," no heavy client-side transcoding dependency (`docs/01-ARCHITECTURE.md` §5's own "15s video, H.264 720p" line is flagged there as aspirational and unbuilt). Nothing about that reasoning is status-specific; it applies identically to chat.
- **Moderation covers text only.** `packages/moderation/openai.ts`'s `ContentModerationProvider` has one method, `moderateText`. There is no image-moderation call anywhere in this codebase. OpenAI's `omni-moderation-latest` model (the one already integrated) does support image input in its real API — extending the existing provider is additive, not a new vendor integration, but it is unbuilt and unverified today, same "not yet confirmed against a real live call" caveat that file's own header already carries for text.
- **Chat billing is escrow-based; status billing is not.** Per `docs/03-ECONOMY-LEDGER.md` §4–5, every chat message debits the sender, escrows the credit, and only releases to the recipient as earnings once they reply. Status uploads (§7) are a flat direct debit with no escrow, no earning. A media _chat_ message must go through the exact same escrow/release/refund machinery as a text message — it is a message with an attachment, not a parallel product.

## 2. What "v1 chat media" means, concretely

**In scope:**

- One photo per message, sent from camera or gallery, with an optional text caption.
- Client-side resize/compress before upload (target: 1600px longest edge, WebP — matches the existing architecture budget line).
- Thumbnail-in-bubble + tap-to-view full-resolution image viewer (pinch-zoom, matching `docs/04-DESIGN-SYSTEM.md` motion/interaction conventions).
- Billing: a media message still costs credits and still escrows/releases/refunds exactly like a text-only message today — see §3.
- Deletion: "delete for everyone" (already built, `fn_delete_message_for_everyone`) must also remove the Storage object, not just blank the row — that function doesn't touch Storage today and will need to.

**Explicitly out of v1 scope (a follow-up, not an oversight):**

- **Video.** Same reasoning as status: no heavy client-side transcoding dependency without a real product decision to add one. If this is wanted later, scope it as its own pass — it's a genuinely different engineering problem (transcoding, longer uploads, preview generation), not a checkbox on this one.
- Voice notes, documents/files, multiple-photo-per-message (albums), and location — none of these were asked for; each is its own scoping pass if wanted.
- Media search/gallery view beyond the existing shared-links panel (`useThreadSharedLinks` already exists for links; a media-grid equivalent is a natural but separate follow-up).
- Forwarding a media message — `ForwardMessageModal` exists today for text; extending it to carry an attachment is additional scope, not assumed here.

## 3. Pricing (config-driven, server-computed — CLAUDE.md rules #1/#9, non-negotiable)

**Proposed model:** a media attachment adds a flat, config-driven surcharge on top of the existing word-count formula — it does **not** replace or fork that formula. A photo with no caption still costs at least the surcharge; a photo with a 60-word caption costs the surcharge plus whatever that caption alone would cost as text.

```
credits_charged = message_base_credits × max(word_blocks, 1)          // existing formula, docs/03 §4
                 + (has_media ? message_media_credits : 0)            // new, flat
```

- `message_media_credits` — new `pricing_config` row, new constant, never hardcoded (mirrors `status_upload_credits_media`'s own existing pattern exactly).
- Computed inside `fn_send_message`, same as every other billing number today — the client's preview is cosmetic only, same posture as the existing word-count preview.
- The whole attachment still escrows as one unit with the rest of the message; release/refund/edit-window rules are unchanged (a media message that never gets a reply refunds in full via the existing `escrow-expiry-sweep`, same as text).
- **Editing:** `fn_edit_message`'s existing "may never exceed the original `credits_charged`" rule needs one explicit decision before building: can an edit _add_ a photo to a text-only message (a cost increase, currently rejected outright), or _remove_ one (a cost decrease, currently allowed)? Recommend: swapping/adding media on edit is disallowed entirely (`edit_would_increase_cost` or a new explicit `media_not_editable`), same spirit as the existing rule — simpler, and matches WhatsApp's own behavior (you can't edit a photo into a message after sending).

## 4. Storage & schema design

**New bucket:** `chat-media`, private, mirroring `status-media`'s posture exactly — size ceiling and allowed MIME types are a product/ops call at build time (status uses 5 MiB / `image/jpeg`+`image/png`; chat could reasonably match or differ slightly, e.g. allowing `image/webp` given the compress target above).

**New Edge Functions**, exact status-media shape:

- `create-chat-media-upload-url` — mints a one-time signed upload slot (service role), same as `create-status-upload-url`.
- No separate "read URL" function needed — reads go through `createSignedUrl` from the client's own session, same as status, gated by a new RLS policy (see below).

**Schema (new migration):**

- `messages.media_path` (nullable `text`) and `messages.media_type` (nullable `text`, e.g. `'image'` — future-proofs the column for the video follow-up without a second migration later) — additive, nullable columns, forward-only migration per CLAUDE.md.
- `storage.objects` SELECT RLS for the new bucket (`chat_media_select_visible`) — re-derives "caller is a participant in the message's thread, and the thread isn't blocked," the same predicate the `messages`/`threads` RLS already encodes elsewhere. Same "RLS can't reference another table's policy, so this is a deliberate repetition, not a new pattern" note `status_media_select_visible`'s own migration already makes.
- `storage.objects` DELETE RLS (`chat_media_delete_own`) for the sender's own media, needed for `fn_delete_message_for_everyone`'s Storage cleanup — same ordering hazard status's own delete path already documents (remove the Storage object **before** clearing the row/blanking the path, never after, since the RLS `EXISTS` check needs the row to still exist while authorizing the delete).

**`fn_send_message` changes:** accept an optional `p_media_path`/`p_media_type`, validate the path was actually issued by `create-chat-media-upload-url` for this sender (same trust boundary the status pipeline already established — the Edge Function's signed-URL minting is the actual authorization, not a client-supplied path taken on faith), compute `credits_charged` per §3, otherwise unchanged.

## 5. Moderation

Image moderation does not exist in this codebase today (§1). Two real options, not a false binary:

1. **Extend `ContentModerationProvider` with `moderateImage`**, backed by OpenAI's existing `omni-moderation-latest` (already integrated for text, same vendor, same API family) — the lower-effort path since it reuses the existing provider/config/key rather than adding a second vendor.
2. Accept photo messages as **unmoderated at launch**, same "flag it for legal review rather than shipping it live" posture CLAUDE.md's compliance section already asks for when a feature touches this ground — this is a real content-safety gap for a chat app doing app-store review (`docs/07-COMPLIANCE-LEGAL.md`), not a minor detail, and shouldn't be silently skipped.

Recommend (1) before this ships to general availability, not as a fast-follow — an unmoderated image-upload feature in a stranger-to-stranger paid-messaging app is a real app-store-review and legal exposure, not a nice-to-have.

## 6. Client pipeline (mirrors the status pipeline's own shape)

1. `expo-image-picker` (camera or gallery) — already a dependency (status uses it via `StatusComposer`), no new package.
2. `expo-image-manipulator` resize/compress to the 1600px/WebP target — already a dependency, same call shape `StatusComposer` already makes (adjusted for WebP output instead of status's JPEG — confirm `ImageManipulator.SaveFormat.WEBP` support on both platforms before committing to WebP over JPEG; fall back to JPEG if it's meaningfully less reliable cross-platform, this is a real thing to verify live, not assume).
3. Call `create-chat-media-upload-url`, upload via `uploadToSignedUrl` — same Blob-wrapping caveat `uploadStatusMedia`'s own detailed comment already documents (RN's `Blob` polyfill only accepts `Blob`/string parts, and `fileOptions.contentType` is silently ignored on the Blob upload path — the Blob's own `.type` is what actually matters). This is a real, previously-hit bug, not a hypothetical to rediscover.
4. `handleSend` gains a media branch alongside the existing text path — same optimistic-bubble treatment this session's `fix/thread-realtime-smoothness` work already built for text sends (a `SendingMessageBubble`-equivalent showing the local image immediately, swapped for the real message once it lands), not a separate, lesser UX for media.
5. `MessageBubble` gains an image-rendering branch (thumbnail, tap → full-screen viewer with pinch-zoom) — a new small component, not a new screen; `docs/04-DESIGN-SYSTEM.md` tokens only, no ad-hoc styling.

## 7. Build order (phased, matching how every other multi-part piece in this app has actually shipped — schema/storage first, then server, then client, each independently mergeable)

1. Migration: `messages.media_path`/`media_type`, `chat-media` bucket + RLS.
2. `create-chat-media-upload-url` Edge Function + test (happy path, wrong-user rejection).
3. `fn_send_message` media support + billing (`message_media_credits` config) + test (ledger-conservation + concurrency, per CLAUDE.md's own testing mandate for any balance-mutating function).
4. `fn_delete_message_for_everyone` Storage cleanup.
5. Moderation extension (§5) — recommended before general availability, not blocking the rest of the build.
6. Client: composer attach flow, optimistic send, bubble rendering, full-screen viewer.

Each of these is independently reviewable/mergeable, same cadence this session's four pieces shipped in.
