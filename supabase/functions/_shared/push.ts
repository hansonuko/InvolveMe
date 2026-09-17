// _shared/push.ts — best-effort push notification sending via Expo's
// push API (docs/01-ARCHITECTURE.md's chosen mechanism: "Expo
// Notifications (FCM/APNs under the hood)"). No SDK needed — Expo's push
// service is a plain HTTPS endpoint.
//
// Deliberately "fire and forget, never fails the caller": a push
// notification is a nice-to-have on top of a real action (a message was
// already sent and billed correctly by the time this runs) — a flaky
// push provider must never turn into a 500 on send-message itself.
// Callers should invoke this via EdgeRuntime.waitUntil() where available
// (Supabase's Edge Runtime) so it doesn't add push-provider latency to
// the response either; falls back to a plain awaited call if that global
// isn't present (e.g. under `deno run` in this project's own test
// harness, which spawns functions directly rather than through the
// platform's edge runtime).
//
// No `users.push_notifications_enabled`-style column exists — "off" is
// modeled as "no rows in push_tokens for this user" (the client deletes
// its token when the user disables notifications in Settings, or never
// registered one if permission was denied), so there's exactly one
// source of truth instead of a flag that could drift out of sync with it.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';

export function runInBackground(work: () => Promise<void>): void {
  const rt = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<void>) => void } })
    .EdgeRuntime;
  if (rt?.waitUntil) {
    rt.waitUntil(work());
  } else {
    // No background-task API available — still fire and forget rather
    // than block the response on a third-party HTTP call, but there's
    // nothing to hand the promise to that outlives this request, so any
    // rejection is caught and logged here instead of propagating.
    void work();
  }
}

export async function sendPushToUser(
  db: SupabaseClient,
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    const { data: tokens, error } = await db
      .from('push_tokens')
      .select('token')
      .eq('user_id', userId);

    if (error) {
      console.error('sendPushToUser: token lookup failed:', error.message);
      return;
    }
    if (!tokens?.length) {
      return; // no device registered, or the user has notifications off
    }

    const messages = tokens.map((t) => ({
      to: t.token,
      title,
      body,
      data: data ?? {},
      sound: 'default',
    }));

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });

    if (!res.ok) {
      console.error('sendPushToUser: Expo push API returned', res.status, await res.text());
    }
  } catch (e) {
    console.error('sendPushToUser: unexpected failure (non-fatal):', e);
  }
}

/** Shared by every `fn_confirm_topup` call site (`webhook-flutterwave`,
 * `reconcile-topups`, `check-topup-status`) — one place for the message
 * copy and the `topups` read-back, rather than three near-duplicates.
 * `fn_confirm_topup` itself `returns void`, so this reads `user_id`/
 * `credits_issued` back off the row it just updated. Best-effort like
 * `sendPushToUser` itself — a lookup failure here must never surface as an
 * error to whichever caller triggered the confirm. */
export async function notifyTopupConfirmed(db: SupabaseClient, topupId: string): Promise<void> {
  try {
    const { data: topup, error } = await db
      .from('topups')
      .select('user_id, credits_issued')
      .eq('id', topupId)
      .single();
    if (error || !topup) {
      console.error('notifyTopupConfirmed: topup lookup failed:', error?.message);
      return;
    }
    await sendPushToUser(
      db,
      topup.user_id,
      'Credit purchased',
      `${topup.credits_issued} credits have landed in your wallet.`,
      { type: 'topup_confirmed', topup_id: topupId },
    );
  } catch (e) {
    console.error('notifyTopupConfirmed: unexpected failure (non-fatal):', e);
  }
}

/** Same rationale as `notifyTopupConfirmed` — the one place
 * `webhook-flutterwave`'s `fn_complete_withdrawal` success branch needs to
 * read a completed withdrawal back to notify its owner. */
export async function notifyWithdrawalCompleted(
  db: SupabaseClient,
  withdrawalId: string,
): Promise<void> {
  try {
    const { data: withdrawal, error } = await db
      .from('withdrawals')
      .select('user_id, amount_kobo')
      .eq('id', withdrawalId)
      .single();
    if (error || !withdrawal) {
      console.error('notifyWithdrawalCompleted: withdrawal lookup failed:', error?.message);
      return;
    }
    await sendPushToUser(
      db,
      withdrawal.user_id,
      'Withdrawal sent',
      `₦${(withdrawal.amount_kobo / 100).toLocaleString()} has been sent to your bank account.`,
      { type: 'withdrawal_completed', withdrawal_id: withdrawalId },
    );
  } catch (e) {
    console.error('notifyWithdrawalCompleted: unexpected failure (non-fatal):', e);
  }
}
