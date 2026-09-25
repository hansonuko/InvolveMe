// POST /functions/v1/expire-statuses
//
// Server-to-server only, triggered by pg_cron via pg_net (see migration
// 20260925100000_status_expiry_sweep.sql) — same shape as reconcile-topups,
// not called by the app.
//
// WHY THIS EXISTS: statuses are supposed to disappear 24h after posting,
// for the poster too, same as WhatsApp — 20260925100000's own RLS change
// (`status_updates_select_own` now requires `expires_at > now()`) already
// makes that true the instant a status ages out, for every reader of the
// table including the poster. This function is the other half: an expired
// row's Storage object was never actually being cleaned up (nothing in this
// codebase deleted it once the 24h window passed), and the row itself would
// otherwise sit in `status_updates` forever. RLS hides it; this removes it.
//
// Storage objects are removed *before* their status_updates row (matching
// useDeleteStatus's own documented ordering concern) even though it isn't
// strictly load-bearing here — this runs as service_role, which bypasses
// the bucket's RLS-based delete policy entirely. Kept anyway so a mid-run
// failure leans toward "orphaned blob nobody references" rather than "row
// gone, blob left with nothing pointing at it" — the cheaper failure mode
// either way, but this is the cheaper of the two.
//
// Auth: same X-Cron-Secret posture as reconcile-topups, for the same
// reason (pg_net has no clean way to attach a real user JWT). Reuses the
// same CRON_INTERNAL_SECRET function secret / vault entry — a generic
// "this call came from this project's own cron," not topup-specific.

import { timingSafeEqual } from 'node:crypto';
import { serviceRoleClient } from '../_shared/auth.ts';

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkCronSecret(req: Request): boolean {
  const expected = Deno.env.get('CRON_INTERNAL_SECRET') ?? '';
  const actual = req.headers.get('x-cron-secret') ?? '';
  if (!expected || !actual) return false;
  const expectedBuf = new TextEncoder().encode(expected);
  const actualBuf = new TextEncoder().encode(actual);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

// One run per cron tick shouldn't unboundedly grow — same batching posture
// as reconcile-topups' own limit. The cron interval (every 15 minutes, see
// the migration) comfortably drains any single-tick backlog well before it
// could ever reach this many expired-in-one-window statuses at this app's
// scale.
const BATCH_SIZE = 200;

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return json(405, { error: 'method_not_allowed', message: 'Use POST.' });
  }
  if (!checkCronSecret(req)) {
    return json(401, { error: 'unauthorized', message: 'Invalid or missing X-Cron-Secret.' });
  }

  const db = serviceRoleClient();

  const { data: expired, error: queryError } = await db
    .from('status_updates')
    .select('id, media_path')
    .lte('expires_at', new Date().toISOString())
    .limit(BATCH_SIZE);

  if (queryError) {
    console.error('expire-statuses: could not query expired statuses:', queryError.message);
    return json(500, { error: 'internal_error', message: 'Could not query status_updates.' });
  }

  if (!expired?.length) {
    return json(200, { expired: 0, media_removed: 0, errors: [] });
  }

  const errors: string[] = [];

  const mediaPaths = expired
    .map((s) => s.media_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  let mediaRemoved = 0;
  if (mediaPaths.length) {
    const { error: storageError } = await db.storage.from('status-media').remove(mediaPaths);
    if (storageError) {
      // One bad batch must not stop the row cleanup below — an orphaned
      // blob is the acceptable failure mode here, not a status stuck
      // undeleted forever because Storage hiccupped once.
      console.error('expire-statuses: storage removal failed:', storageError.message);
      errors.push(`storage: ${storageError.message}`);
    } else {
      mediaRemoved = mediaPaths.length;
    }
  }

  const ids = expired.map((s) => s.id);
  const { error: deleteError } = await db.from('status_updates').delete().in('id', ids);
  if (deleteError) {
    console.error('expire-statuses: row cleanup failed:', deleteError.message);
    errors.push(`delete: ${deleteError.message}`);
  }

  return json(200, { expired: ids.length, media_removed: mediaRemoved, errors });
});
