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
