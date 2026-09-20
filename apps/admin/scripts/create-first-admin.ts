#!/usr/bin/env node
// Bootstrap script — the ONLY way to create the first admin_users row
// (docs/14-ADMIN-DASHBOARD-SCOPING.md §8.1 point 1). Run manually, once per
// environment, with service-role credentials on your own machine — never
// deployed as a route a browser can reach.
//
// Deliberately does NOT touch TOTP/MFA — fn_admin_bootstrap_first_user
// creates the account with a password only; the first real login then goes
// through the exact same /mfa-enroll flow every other admin uses (the login
// action already redirects there when totp_enrolled_at is null), so there's
// one enrollment code path in this whole app, not two.
//
// Usage (from apps/admin/):
//   npm run create-first-admin -- --email you@involveme.com --name "Your Name" --password "at least 12 chars"
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in apps/admin/.env.local
// (see .env.example) — loaded via `node --env-file`, per the npm script.

import { parseArgs } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { hashPassword } from '../lib/crypto';

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
    },
  });

  if (!values.email || !values.name || !values.password) {
    console.error(
      'Usage: npm run create-first-admin -- --email <email> --name "<display name>" --password "<12+ chars>"',
    );
    process.exit(1);
  }
  if (values.password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set (see apps/admin/.env.example).',
    );
    process.exit(1);
  }

  const client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { count, error: countError } = await client
    .from('admin_users')
    .select('id', { count: 'exact', head: true });
  if (countError) {
    console.error('Could not check admin_users:', countError.message);
    process.exit(1);
  }
  if (count && count > 0) {
    console.error(
      `Refusing to run: admin_users already has ${count} row(s). This script only ever creates the FIRST admin — use the "Create admin account" page in the dashboard for every admin after that.`,
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(values.password);
  const { data, error } = await client.rpc('fn_admin_bootstrap_first_user', {
    p_email: values.email,
    p_display_name: values.name,
    p_password_hash: passwordHash,
  });

  if (error) {
    console.error('Bootstrap failed:', error.message);
    process.exit(1);
  }

  console.log(`Created the first admin (super_admin): ${values.email} (id: ${data})`);
  console.log(
    "Log in at /login with this email/password now — you'll be walked through TOTP enrollment immediately.",
  );
}

main().catch((e) => {
  console.error('SCRIPT_ERROR:', e instanceof Error ? e.message : e);
  process.exit(1);
});
