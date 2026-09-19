import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState } from 'react-native';

/**
 * Supabase client — auth + realtime reads only.
 *
 * Per CLAUDE.md rule #1: this app never computes balances, credit costs, or
 * fee splits. It calls Edge Functions for every money-affecting action and
 * subscribes to Realtime for read-only state (see docs/05-API-REALTIME-SPEC.md).
 *
 * Session storage uses AsyncStorage per Supabase's official React Native
 * guidance (SecureStore has a ~2KB per-value limit that a session JWT can
 * exceed). Revisit before production if session payload sensitivity warrants
 * an encrypted-storage wrapper — flagged here, not solved in Phase 0.
 */

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Loud in dev, not a thrown error — lets the app boot to the "not configured"
  // state instead of crashing before a Supabase project exists (Phase 0 reality:
  // the dev project is created once, not before this scaffold lands).
  console.warn(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are not set. ' +
      'Copy .env.example to apps/mobile/.env and fill in your dev project values.',
  );
}

// createClient() validates its URL argument and throws synchronously on an
// empty string — that would crash the app at import time, before any screen
// even renders, whenever .env isn't configured yet. A well-formed placeholder
// keeps construction safe; real calls then fail at the network layer with a
// normal, catchable error instead of a hard crash on boot.
export const supabase = createClient(
  supabaseUrl ?? 'https://placeholder.supabase.co',
  supabaseAnonKey ?? 'placeholder-anon-key',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  },
);

// Real gap found 2026-09-20 investigating a live user report of being
// bounced back to the phone-number entry screen far more often than a
// WhatsApp-equivalent app should — this is Supabase's own officially
// documented requirement for React Native that this app never wired up.
// `autoRefreshToken: true` above only keeps the access token refreshed via
// a JS timer that ticks while the app is in the foreground; React Native
// suspends JS execution (including timers) the moment the app is
// backgrounded, so that timer cannot fire to refresh a token that expires
// while the user has switched away — the default access-token lifetime is
// commonly 1 hour, which is a completely ordinary amount of time for a
// messaging app to sit backgrounded during a normal day. Without this,
// returning to the app after that window finds an expired access token
// with no refresh ever attempted, which supabase-js then can't silently
// recover from — the client reports no session, and app/_layout.tsx's
// auth gate (correctly, given what it's told) routes back to `/(auth)`,
// the phone-number entry screen, exactly matching the report. This makes
// every foreground transition explicitly kick the refresh check itself,
// closing the gap instead of relying on a timer that may never get to run.
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    void supabase.auth.startAutoRefresh();
  } else {
    void supabase.auth.stopAutoRefresh();
  }
});
