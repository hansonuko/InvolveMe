// _shared/moderation-config.ts — reads the env vars content moderation
// needs into an OpenAiModerationConfig, mirroring _shared/kyc-config.ts's
// pattern (which itself mirrors _shared/flutterwave-config.ts's).

import type { OpenAiModerationConfig } from '../../../packages/moderation/openai.ts';

export function loadOpenAiModerationConfig(): OpenAiModerationConfig {
  return {
    apiKey: Deno.env.get('OPENAI_API_KEY') ?? '',
  };
}
