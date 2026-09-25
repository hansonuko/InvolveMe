/**
 * ContentModerationProvider interface — mirrors packages/payments/provider.ts
 * and packages/kyc/provider.ts's pattern (CLAUDE.md rule #5's spirit,
 * applied here the same way it already was for KYC): every moderation
 * vendor call goes through this, never a vendor SDK directly from a
 * feature module. docs/06-SECURITY-FRAUD-LOOPHOLES.md §6 and
 * docs/07-COMPLIANCE-LEGAL.md §3 are what this exists for.
 *
 * Two-tier response, not a single flagged/clean boolean: `docs/00-SESSION-
 * HANDOFF.md` session 13 records the explicit product decision behind
 * this — severe categories (sexual content involving minors, credible
 * violence/hate threats) block the content outright before it's ever
 * inserted or charged; everything else flagged is allowed to send
 * normally but logged for review, same manual-review posture the
 * collusion-detection fraud signals already use. `send-message`/
 * `post-status` are the callers; see those functions for exactly where
 * this is invoked relative to their billing RPC.
 */

export type ModerationAction = 'blocked' | 'flagged' | 'clean';

export interface ModerationResult {
  action: ModerationAction;
  /** Which category names triggered the action, for the audit log
   * (moderated_content.categories) — empty when action is 'clean'. */
  categories: string[];
}

export interface ContentModerationProvider {
  readonly name: 'openai';
  moderateText(text: string): Promise<ModerationResult>;
  /** docs/16-CHAT-MEDIA-SCOPING.md §5 — same category → action mapping as
   * `moderateText`, against `omni-moderation-latest`'s own image-input
   * support (same model, same endpoint, same vendor call this interface
   * already wraps for text). `imageBytes` is base64-encoded into a data
   * URI by the implementation rather than passed as a Storage URL — the
   * bucket this is called against (`chat-media`) is private, so a plain
   * URL isn't fetchable by OpenAI's servers without either a public
   * exposure this app doesn't want or a signed URL round trip this avoids
   * entirely by just sending the bytes it already has. **Not yet
   * confirmed against a real live call**, same caveat `openai.ts`'s own
   * header comment carries for text — whoever wires the real key should
   * make one real call with a genuinely flagged image and confirm the
   * response shape before trusting this in production. */
  moderateImage(imageBytes: Uint8Array, mimeType: string): Promise<ModerationResult>;
  /** docs/17-VOICE-NOTES-SCOPING.md §6 — no direct audio-input moderation
   * exists on `omni-moderation-latest` the way it does for images, so this
   * transcribes first (OpenAI's `audio/transcriptions` endpoint, same
   * vendor/key, a second real API call) then runs the transcript through
   * the same `moderateText` category → action mapping. This catches
   * spoken-content abuse; it does **not** catch non-speech audio abuse
   * (e.g. harassment via sound alone) — a real, stated gap, not a silent
   * one (docs/17 §6). **Not yet confirmed against a real live call with
   * genuinely flagged speech**, same caveat every other provider method
   * here carries — confirmed only that the transcription endpoint is
   * reachable with real credentials, not that a truly abusive recording
   * produces the expected block/flag outcome. */
  moderateAudio(audioBytes: Uint8Array, mimeType: string): Promise<ModerationResult>;
}
