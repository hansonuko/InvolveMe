// _shared/rateLimit.ts — thin wrapper around fn_check_rate_limit
// (20260926150000_api_rate_limiting.sql, docs/19-SECURITY-HARDENING-
// SCOPING.md §3). Each calling function still builds its own 429 response
// (matching every other shared check in this codebase — auth.ts throws,
// callers map the error to their own response shape) so the message/body
// stays consistent with that function's own conventions.
//
// Fails OPEN on an unexpected DB error (logs loudly, allows the call) —
// same posture every content-moderation check in this app already uses for
// a provider outage: a rate-limiter bug or transient DB blip must not take
// down the feature it's protecting. This is a defense-in-depth control, not
// the only thing standing between this app and abuse.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export async function checkRateLimit(
  db: SupabaseClient,
  key: string,
  maxCount: number,
  windowSeconds: number,
): Promise<boolean> {
  const { data, error } = await db.rpc('fn_check_rate_limit', {
    p_key: key,
    p_max_count: maxCount,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error(`checkRateLimit: fn_check_rate_limit failed for key "${key}":`, error.message);
    return true;
  }

  return data === true;
}
