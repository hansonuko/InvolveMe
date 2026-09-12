import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

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
