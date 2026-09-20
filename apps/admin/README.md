# InvolveMe Admin

Internal ops console. Next.js App Router, TypeScript, own custom auth
(argon2-class password hashing via Node's built-in `scrypt` + mandatory
TOTP) — see `docs/14-ADMIN-DASHBOARD-SCOPING.md` for the full design and
`docs/00-SESSION-HANDOFF.md` for what's actually built vs. planned.

## Local setup

```
cp .env.example .env.local   # fill in every value — see the file's own comments
npm install                  # from the repo root, not this directory
npm run dev --workspace admin
```

## Creating the first admin (once per environment)

There is no signup page — the only way to create the first `admin_users`
row is this script, run by hand with your own `SUPABASE_SERVICE_ROLE_KEY`:

```
npm run create-first-admin -- --email you@involveme.com --name "Your Name" --password "at least 12 characters"
```

It refuses to run if `admin_users` already has any row. After it succeeds,
log in at `/login` with that email/password — you'll be walked through TOTP
enrollment on first login, same flow every later admin goes through. **Save
the 10 recovery codes shown once at the end of enrollment somewhere safe** —
if you lose both your authenticator app and those codes, recovering this
specific account (the only `super_admin` that exists yet) is a manual
service-role database operation, not a self-service flow (docs/14 §8.1
point 3).

Every admin after the first is created from the dashboard's own "Create
admin account" page by anyone holding the `manage_admin_roles` permission —
never this script again.
