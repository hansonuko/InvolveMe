import { getIsOnline } from '@/lib/network';
import { supabase } from '@/lib/supabase';

/**
 * Thrown for any Edge Function error response — carries the machine `code`
 * (docs/05-API-REALTIME-SPEC.md §5's `{ error, message }` shape) so callers
 * can branch on it (e.g. `insufficient_credit`) instead of string-matching
 * the human message. Per CLAUDE.md rule #1, this is the *only* way this app
 * talks to anything that touches money — no client-side balance/cost math
 * lives anywhere near this file.
 */
export class EdgeFunctionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'EdgeFunctionError';
  }
}

/**
 * Calls a Supabase Edge Function with the current session's access token.
 * Every money-affecting or otherwise-authenticated action in this app goes
 * through here rather than a bespoke fetch call per screen. `body` is
 * omitted entirely for `GET` (e.g. `list-banks`) rather than sent as an
 * empty JSON object — some of this project's functions reject a GET with
 * a body outright.
 */
export async function callEdgeFunction<TResponse>(
  name: string,
  body?: Record<string, unknown>,
  method: 'GET' | 'POST' = 'POST',
): Promise<TResponse> {
  // Offline gate (docs/13-OFFLINE-MODE-SCOPING.md) — every money-affecting
  // or otherwise-authenticated action in this app goes through this one
  // function (per this file's own header comment), so checking here covers
  // every caller for free rather than needing a per-screen check. Fails
  // fast with the same EdgeFunctionError shape every existing caller
  // already handles, instead of letting `fetch` hang or throw a generic
  // network error. The one caller that must NOT hit this gate is the
  // outbox drain itself, which only ever calls this once `useIsOnline()`
  // has already reported true, so there's no risk of the queued send being
  // silently blocked by its own trigger condition.
  if (!getIsOnline()) {
    throw new EdgeFunctionError('offline', "You're offline — try again once you're connected.", 0);
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new EdgeFunctionError('unauthorized', 'Not signed in.', 401);
  }

  const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    throw new EdgeFunctionError(
      json?.error ?? 'unknown_error',
      json?.message ?? `Request failed with status ${res.status}`,
      res.status,
      json,
    );
  }

  return json as TResponse;
}
