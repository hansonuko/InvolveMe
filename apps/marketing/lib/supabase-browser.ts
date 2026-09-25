'use client';

import { createClient } from '@supabase/supabase-js';

// docs/15-MARKETING-SITE-PWA-SCOPING.md §4.3: a successful OTP verify on
// the marketing site must NOT leave the visitor "logged into a web
// session with app access" — persistSession: false is the concrete
// mechanism for that. Nothing from this client is ever written to
// localStorage/cookies, so there's genuinely no session left once the
// page navigates to /download; this isn't just a UI convention.
export function createBrowserSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set.');
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
