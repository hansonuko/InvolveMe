/**
 * OpenAI adapter — implements `ContentModerationProvider` (see provider.ts's
 * header comment). Built against OpenAI's public, documented moderation
 * endpoint — a stable, widely-used API, unlike Flutterwave v4's real
 * surprises during integration — but **not yet confirmed against a real
 * live call**, because no `OPENAI_API_KEY` exists in this environment yet
 * (docs/00-SESSION-HANDOFF.md session 13: built now, wired live once a
 * key is provided, same gap KYC/payments had before their real
 * credentials arrived). Whoever adds the key should make one real call
 * with genuinely flagged text and confirm the response shape/category
 * names below match before trusting this in production — the exact
 * mistake `packages/kyc/prembly.ts`'s own header comment warns about
 * (reading docs confidently is not the same discipline as a live call).
 *
 * Category → action mapping (docs/00-SESSION-HANDOFF.md session 13's
 * explicit product decision): categories representing an immediate,
 * severe safety risk hard-block; every other flagged category is allowed
 * through but logged. `omni-moderation-latest`'s documented category set
 * at the time this was written — confirm this list is still current
 * against OpenAI's own docs before relying on it, category names have
 * changed across model versions before.
 */

import type { ContentModerationProvider, ModerationAction, ModerationResult } from './provider.ts';

export interface OpenAiModerationConfig {
  apiKey: string;
}

const BASE_URL = 'https://api.openai.com/v1/moderations';

/** Categories severe enough to block the content outright, never
 * delivered or charged. Everything else OpenAI flags is a 'flagged'
 * (allow + log) outcome, not 'clean' — see moderateText below. */
const BLOCK_CATEGORIES = new Set([
  'sexual/minors',
  'hate/threatening',
  'harassment/threatening',
  'violence/graphic',
  'self-harm/instructions',
  'illicit/violent',
]);

interface OpenAiModerationResponse {
  results: {
    flagged: boolean;
    categories: Record<string, boolean>;
  }[];
}

/** Image content-part shape omni-moderation-latest's multi-modal `input`
 * accepts — the same `{ type: 'image_url', image_url: { url } }` shape
 * OpenAI's chat-completions vision API already uses, not a moderation-
 * specific format. A data URI (not a Storage URL) so OpenAI never needs
 * to fetch anything from this app's private `chat-media` bucket — see
 * provider.ts's own comment on `moderateImage` for why. */
type OpenAiModerationInput = string | { type: 'image_url'; image_url: { url: string } }[];

/** Shared request/response handling for both moderateText and
 * moderateImage — same endpoint, same model, same category→action
 * mapping, differing only in the shape of `input`. */
async function runModeration(
  config: OpenAiModerationConfig,
  input: OpenAiModerationInput,
): Promise<ModerationResult> {
  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'omni-moderation-latest', input }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI moderation request failed: HTTP ${res.status} — ${body.slice(0, 500)}`);
  }

  const parsed = (await res.json()) as OpenAiModerationResponse;
  const result = parsed.results[0];
  if (!result || !result.flagged) {
    return { action: 'clean', categories: [] };
  }

  const flaggedCategories = Object.entries(result.categories)
    .filter(([, isFlagged]) => isFlagged)
    .map(([category]) => category);

  const action: ModerationAction = flaggedCategories.some((c) => BLOCK_CATEGORIES.has(c))
    ? 'blocked'
    : 'flagged';

  return { action, categories: flaggedCategories };
}

/** Transcribes audio via OpenAI's `audio/transcriptions` endpoint
 * (Whisper) — a different endpoint from `runModeration` above (multipart
 * form upload, not a JSON `input`), so it's its own function rather than
 * folded into that shared helper. Returns the raw transcript text; an
 * empty/silent recording legitimately transcribes to an empty string,
 * which moderateAudio below treats the same way moderateText already
 * treats empty input — nothing to moderate, 'clean'. */
async function transcribeAudio(
  config: OpenAiModerationConfig,
  audioBytes: Uint8Array,
  mimeType: string,
): Promise<string> {
  const extension = mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : 'bin';
  const form = new FormData();
  // `Uint8Array<ArrayBufferLike>` vs. `BlobPart`'s `ArrayBuffer<ArrayBuffer>`
  // expectation is a lib.dom.d.ts generic-strictness mismatch, not a real
  // runtime incompatibility — Blob has always accepted a Uint8Array.
  form.append('file', new Blob([audioBytes as BlobPart], { type: mimeType }), `audio.${extension}`);
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `OpenAI transcription request failed: HTTP ${res.status} — ${body.slice(0, 500)}`,
    );
  }

  const parsed = (await res.json()) as { text?: string };
  return parsed.text ?? '';
}

/** Encodes a byte array to base64 without Node's `Buffer` (Deno's Edge
 * Function runtime has it too, but this package is shared/imported from
 * plain TS, not Deno-specific — no assumption either way). Fine for the
 * image sizes this ever sees (chat-media's own 5 MiB bucket ceiling,
 * docs/16 §4) — not a hot path warranting a streaming encoder. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function createOpenAiModerationProvider(
  config: OpenAiModerationConfig,
): ContentModerationProvider {
  return {
    name: 'openai',

    async moderateText(text: string): Promise<ModerationResult> {
      // Empty/whitespace-only input has nothing to moderate — fn_send_message
      // and fn_post_status already reject empty content themselves, this
      // is just a cheap short-circuit so this function's caller doesn't
      // spend an API call on it.
      if (!text || text.trim().length === 0) {
        return { action: 'clean', categories: [] };
      }

      return runModeration(config, text);
    },

    async moderateImage(imageBytes: Uint8Array, mimeType: string): Promise<ModerationResult> {
      if (!imageBytes || imageBytes.length === 0) {
        return { action: 'clean', categories: [] };
      }

      const dataUri = `data:${mimeType};base64,${bytesToBase64(imageBytes)}`;
      return runModeration(config, [{ type: 'image_url', image_url: { url: dataUri } }]);
    },

    async moderateAudio(audioBytes: Uint8Array, mimeType: string): Promise<ModerationResult> {
      if (!audioBytes || audioBytes.length === 0) {
        return { action: 'clean', categories: [] };
      }

      const transcript = await transcribeAudio(config, audioBytes, mimeType);
      if (!transcript || transcript.trim().length === 0) {
        return { action: 'clean', categories: [] };
      }

      return runModeration(config, transcript);
    },
  };
}
