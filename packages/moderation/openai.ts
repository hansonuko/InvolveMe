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

      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `OpenAI moderation request failed: HTTP ${res.status} — ${body.slice(0, 500)}`,
        );
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
    },
  };
}
