/* eslint-disable @typescript-eslint/no-explicit-any -- no generated Database
   type exists for admin_* tables/functions yet (see comment below); `any`
   here is a deliberate, scoped choice, not an oversight. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-only. This key never reaches a client bundle — every file that
// imports this module must itself only ever run in a Server Action, Route
// Handler, or Server Component (docs/14-ADMIN-DASHBOARD-SCOPING.md §7.2).
//
// Typed `any` deliberately — there's no generated Database type for
// admin_* tables/functions yet (packages/ledger-types only covers the
// consumer-app schema, and generating one for this app is out of scope for
// Phase A). Correctness here is enforced by
// supabase/tests/admin-rbac-functions.test.js against the real schema, not
// by the TypeScript compiler.
function getServiceClient(): SupabaseClient<any, any, any> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

let cached: SupabaseClient<any, any, any> | null = null;

export function db(): SupabaseClient<any, any, any> {
  if (!cached) cached = getServiceClient();
  return cached;
}
