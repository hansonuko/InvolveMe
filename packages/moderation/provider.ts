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
}
