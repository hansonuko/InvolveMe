-- Profile photo/cover upload, profile links, and WhatsApp-style two-step
-- verification (punch-list item 2, 2026-09-18/19). Three independent
-- additions to `users`, bundled in one migration since they're all part of
-- the same "Settings > Profile/Account" restructure:
--
-- 1. Photo/cover upload — a second public Storage bucket, `profile-media`.
--    Deliberately PUBLIC (unlike `status-media`, which is private and
--    read via short-lived signed URLs): `avatar_url` is already read
--    directly as an `<Image source={{ uri }}>` URI everywhere in this app
--    (ThreadRow, GroupRow, the thread header, ...) — making this bucket
--    private would mean re-plumbing every one of those call sites through
--    a signed-URL hook just to add upload, which this feature doesn't
--    need. A public avatar/cover photo is also just how profile photos
--    work in every reference app this feature is matching. Writes still
--    only ever happen via a signed upload URL from a new Edge Function
--    (create-profile-upload-url) — the same "no client INSERT policy at
--    all" posture `status-media` already established, for the same
--    reason (the signed token itself authorizes the write, not a
--    Postgres RLS row).
-- 2. `links` — a small jsonb array of `{label, url}`, client-writable via
--    the same direct-RLS-update posture `display_name`/`status_text`
--    already use (no financial or security logic here, a plain profile
--    field).
-- 3. Two-step verification — a PIN, not a password (WhatsApp itself has
--    no password-based login; it's phone+OTP with an optional 6-digit PIN
--    required to re-register the number, per the product decision on
--    record for this feature). `two_step_pin_hash` is SHA-256+pepper,
--    same hashing shape `submit-kyc`'s BVN/NIN handling already
--    establishes. `two_step_recovery_email` is captured but NOT wired to
--    actual email delivery — this app has no outbound-email sending
--    capability at all (confirmed: grepped, none exists), and building
--    one is a real infra/vendor decision out of scope for this pass, same
--    "flag it, don't fake it" posture the calls-monetization scoping doc
--    used for its own deferred infra.
--
--    Forgotten-PIN design, corrected mid-build from the original plan:
--    the first instinct — "a fresh OTP re-verification clears the PIN" —
--    doesn't work as a recovery mechanism. Anyone who can reach the PIN
--    gate already has OTP access by definition (that's how they got
--    there); letting OTP alone clear the PIN would make the feature a
--    no-op against the exact scenario it exists to stop (someone else
--    re-registering the number, e.g. after a SIM swap). The real fallback
--    matches WhatsApp's own mechanism instead: `two_step_reset_requested_at`
--    starts a cooldown (`request-two-step-reset`), and only once it has
--    genuinely elapsed — re-checked server-side in `complete-two-step-reset`,
--    never trusted from the client — can the PIN requirement actually be
--    cleared. Slower than an instant bypass on purpose; that's the point.
--
--    `two_step_failed_attempts`/`two_step_locked_until` rate-limit PIN
--    guessing (a 6-digit PIN is only ~1M combinations) — same
--    lock-after-N-attempts shape a payments-adjacent PIN needs regardless
--    of anything else in this app.

alter table public.users
  add column cover_url text,
  add column links jsonb not null default '[]'::jsonb,
  add column two_step_enabled boolean not null default false,
  add column two_step_pin_hash text,
  add column two_step_recovery_email text,
  add column two_step_failed_attempts integer not null default 0,
  add column two_step_locked_until timestamptz,
  add column two_step_reset_requested_at timestamptz;

-- Widen the existing client-update column grant (20260912072749_rls_policies.sql)
-- to include the two new plain profile fields — same posture as
-- display_name/avatar_url/status_text already have. The two_step_* columns
-- are deliberately NOT added here: they only ever change through the
-- Edge Functions below (service_role), which validate a current PIN or a
-- genuinely-elapsed reset cooldown before touching them — a direct client
-- grant would let anyone holding a valid session silently rewrite their
-- own two_step_pin_hash with no verification at all, defeating the point
-- of the feature.
revoke update on public.users from authenticated;
grant update (display_name, avatar_url, status_text, cover_url, links) on public.users to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-media', 'profile-media', true, 5242880, array['image/jpeg', 'image/png']);

-- No INSERT/UPDATE/DELETE policy on storage.objects for this bucket at
-- all — every write goes through create-profile-upload-url's signed
-- upload token (service_role-minted), same as status-media. Public
-- buckets serve GET/HEAD on their objects directly through Storage's own
-- public endpoint, bypassing RLS entirely for reads — nothing to add here
-- for that half.
