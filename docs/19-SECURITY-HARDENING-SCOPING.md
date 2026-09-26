# 19 — Security Hardening: Full-Stack Review & Scoping

**Status: Tier A is built, deployed, and shipped (§9 below) — reviewed against the live codebase, not drafted from a generic checklist; every claim was checked against actual migrations/functions before being written, same discipline every other doc in this repo holds itself to.** Tier B (TLS cert pinning, the §0 E2EE decision) is still open, awaiting your call.

Requested as a full security-engineering pass across encryption, network/transport, DoS mitigation, and injection/input-validation, plus a proposed `CLAUDE.md` hardening section. Read `docs/06-SECURITY-FRAUD-LOOPHOLES.md` and `docs/07-COMPLIANCE-LEGAL.md` first if you haven't recently — this doc deliberately does not repeat what's already covered there (fraud/wash-trading/chargeback threat model, KYC/AML, App Store compliance posture); it's scoped to the _application/network security_ layer those docs don't cover.

## 0. The one decision that gates everything else: real E2EE vs. this app's existing architecture

**This has to be answered before any Signal Protocol/Double Ratchet code gets written, because building it without answering this first would ship something that silently breaks two things this app already committed to.**

Real end-to-end encryption — the Signal Protocol property "not even the server operator can read message content" — is **mechanically incompatible** with two things already built and already load-bearing in this codebase:

1. **Server-side content moderation.** `send-message`'s moderation pipeline (`packages/moderation/`) downloads and reads the actual plaintext/raw bytes of every message, image, and voice note server-side to run it through OpenAI's moderation/transcription API. This isn't incidental — it's the mechanism `docs/07-COMPLIANCE-LEGAL.md` §3 names as a **required App Store/Play Store submission mitigation** for a "paid interaction between strangers" app, and it's already been extended twice this session (status-reply exemption, voice-note audio). A server that can decrypt a message to moderate it is not end-to-end encrypted, by construction — there is no clever implementation that has both properties at once for server-run moderation specifically.
2. **The Terms of Service and Privacy Policy, as already drafted.** `docs/07` §4/§5 record that the drafted ToS/Privacy (`apps/mobile/content/legal/terms.ts`/`privacy.ts`) **already contain an explicit no-E2EE disclosure**, written specifically so the app never has to claim a security property it doesn't have. Shipping real E2EE would be a _good_ change to that disclosure (nothing wrong with truthfully upgrading it) — but shipping the _appearance_ of E2EE while keeping server-side moderation, or shipping E2EE and silently dropping moderation without a decision to do so, are both worse than the status quo.

This exact tension was already identified and scoped in `docs/18-CHAT-STATUS-REFINEMENT-BATCH-SCOPING.md` §D1 this session (the "end-to-end encryption" ask in that batch) — worth reading in full since it reaches the same fork in the road from a different angle. Restating the two honest paths from there, refined for this pass:

**Path 1 — accurate security-posture copy, no crypto rewrite (recommended default).** TLS 1.2/1.3 in transit (already true — see §2), Postgres/Supabase Storage encryption at rest (already true), RLS restricting reads to the two thread participants + service role (already true, see §6 for the honest limits of this), moderation disclosed as a safety feature rather than hidden. This is what WhatsApp itself actually can't claim for its own _Business_ API tier when a business uses server-side automation — "moderated for safety, encrypted in transit and at rest" is a real, defensible, honestly-marketable security posture, not a consolation prize.

**Path 2 — real E2EE as its own large, separately-scoped project**, only if there's a genuine product decision to drop or radically redesign server-side moderation. This is not a crypto-library integration task — it requires, at minimum:

- A real device-key-management system. `docs/12-LINKED-DEVICES-WEB-SCOPING.md` (multi-device support) **is not built** — Signal-style E2EE with multiple logged-in devices per user needs a real key-distribution protocol (per-device identity keys, prekey bundles, session fan-out to every device), not a single client-side key pair. Building E2EE before multi-device exists is building it once, then rebuilding the whole key-management layer when multi-device ships anyway.
- A moderation redesign with a real answer to "what replaces server-side scanning": on-device classification before encryption (a real ML/product project on its own, meaningfully weaker than a hosted LLM moderation pass, and still means the _sender's own device_ sees plaintext, which is fine for E2EE's actual guarantee but means moderation quality drops), or a considered decision to ship with materially less moderation coverage than today, with legal/App-Store review sign-off on that trade-off specifically.
- Metadata is still visible to the server either way (who messaged whom, when, for how long, message sizes) — real E2EE protects content, not the social graph. Worth stating plainly so "100% like WhatsApp" doesn't imply metadata privacy that WhatsApp itself doesn't fully provide either (WhatsApp discloses exactly this limit in its own security whitepaper).

**Recommendation: Path 1.** It gets you the actually-achievable version of "protect user data from MITM, DB leaks, and casual snooping" (§2/§6 below close the real gaps in that), keeps the App Store compliance mitigation intact, and doesn't ship a false claim. Path 2 is a legitimate future project if the appetite is really there, but it should be scoped as its own multi-week effort with an explicit decision to change the moderation posture — not built as a drop-in library integration this pass.

**I need your call on this before touching any of §7 (crypto) below.** Everything else in this doc (§1–§6, §8) is independent of this decision and safe to review/build regardless.

## 1. Architecture reality check — several of the original suggestions assume infrastructure this app doesn't have

Per `docs/01-ARCHITECTURE.md`, InvolveMe has **no custom Node server, no self-hosted reverse proxy, and no self-managed WebSocket server**. The stack is Supabase-managed (Postgres + Auth + Realtime + Storage) plus Supabase Edge Functions (Deno, effectively serverless), fronting a React Native/Expo client. This matters for four of the original suggestions specifically:

| Original suggestion                                                                           | Reality here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nginx/Caddy reverse proxy config for TLS 1.3/HSTS/WSS                                         | There is no reverse proxy to configure — Supabase's own edge (API gateway + CDN) terminates TLS for every Edge Function and Realtime connection, and Supabase controls that layer entirely. Writing an Nginx config would configure infrastructure this app doesn't run. §2 covers what's actually controllable instead (response headers from Edge Functions themselves, and verifying Supabase's own TLS posture rather than assuming it).                                                                                   |
| Redis-based token-bucket/leaky-bucket middleware                                              | Introducing Redis means standing up and operating a new stateful service this app has never needed — a direct conflict with CLAUDE.md rule #10 ("stay lite," check existing tooling before adding a dependency). §3 proposes a Postgres-native equivalent, consistent with how this app already implements every other rate/velocity limit (topup velocity, escrow-release rate caps — all plain Postgres, no Redis anywhere in this codebase today).                                                                          |
| Custom WebSocket server hardening (connection throttling, payload limits, heartbeat timeouts) | Realtime is Supabase's managed WebSocket layer — there's no server process here to add heartbeat/throttle logic to. Supabase Realtime already enforces its own connection/payload limits at the platform level, and already requires a valid JWT to open a channel subscription (see §2.3) — the real, actionable gap is verifying that's actually configured correctly for this project and that no code path bypasses it, not writing a new gateway.                                                                         |
| ORM integration (Prisma/Drizzle) to eliminate SQL injection                                   | Already effectively true, verified by grep: no Edge Function anywhere in this codebase builds a SQL string with interpolated request data — every function calls Postgres exclusively via `.rpc()` (parameterized SECURITY DEFINER function calls) or the Supabase JS query builder's parameterized filters (`.select()/.eq()/.insert()`). Adding an ORM here would add a dependency without closing a gap that doesn't exist. §4 covers the layer that's actually missing (request-shape validation, not query construction). |

None of this means the underlying concerns (transport security, DoS resistance, injection safety) are unaddressed — it means the _mechanism_ has to match what Supabase Edge Functions + Postgres can actually do, which §2–§4 lay out concretely.

## 2. Network & transport security

### 2.1 TLS/HSTS — mostly already true, one thing to verify, one real client-side gap

**Already true (Supabase-managed, not this app's config surface):** every Edge Function and Realtime connection is served over HTTPS/WSS via Supabase's edge network, which runs TLS 1.2/1.3. This isn't optional or something InvolveMe's code enables — it's the only protocol Supabase's endpoints speak at all.

**Real, checkable gap:** whether Supabase's own edge actually sends `Strict-Transport-Security` on every response isn't something to assume — worth a one-time `curl -sI` check against a live Edge Function URL and the project's REST/Realtime endpoints to confirm HSTS is present, since if it's ever missing on any response, that's the one config knob a hosted platform sometimes leaves off by default and app-level code can't add on the platform's behalf. If it's missing, the fix is a Supabase support/config ticket, not application code.

**Real, buildable gap — certificate/transport enforcement on the client.** The RN app calls `EXPO_PUBLIC_SUPABASE_URL` directly via `fetch`/the Supabase JS client. Nothing today explicitly rejects a downgraded connection or pins the certificate. For a financial app, **TLS certificate pinning on the mobile client** (rejecting a MITM proxy even one with a locally-installed rogue CA, e.g. on a compromised or corporate-MDM'd device) is the single highest-value, currently-missing mitigation directly against the MITM scenario named in the original ask. Buildable with `expo-secure-store`-adjacent tooling or a native module (`react-native-ssl-pinning` or Expo's config-plugin equivalent) — real effort (requires a native rebuild, not OTA-updatable, and a pin-rotation plan so a future cert renewal doesn't lock out the whole install base), but it's the concrete, load-bearing "prevent MITM" control the original ask is actually asking for, more than an Nginx TLS config would have been (Supabase already owns that half).

### 2.2 CORS — already correctly built, nothing to add

Checked `supabase/functions/_shared/cors.ts` directly: an explicit origin allow-list (`involveme.com`/`www.involveme.com` + localhost for dev), not a wildcard, applied to the small set of functions actually called from browser JS (`web-send-otp`, per its own header comment explaining exactly why the rest of the ~40 Edge Functions don't need it — they're called from the RN app or server-to-server, neither of which is subject to browser CORS at all). This is already the correct, conservative posture. No change needed.

### 2.3 WebSocket/Realtime auth — already correctly built, worth an explicit verification pass

Supabase Realtime requires a valid JWT to open a channel subscription at all, and every subscription this app makes (`useRealtimeTableChanges` and friends) rides the same authenticated Supabase client the rest of the app uses — there's no code path here using a bare anon key with no session, and RLS is enforced per-row on every Realtime delivery regardless of any client-side `filter` string (confirmed directly in `lib/queries/threads.ts`'s own header comment about why `threads` Realtime has no `filter` — RLS does the real narrowing). This is already what the original ask ("WebSockets must use token-based authentication during the connection upgrade handshake") wants. **One-time verification worth doing, not a code change**: confirm no `service_role` key ever ships to the client bundle (grep the built JS bundle, not just source — a leaked service-role key would bypass RLS entirely and is the single worst possible secret to leak in this architecture). This should be a five-minute check, not assumed.

### 2.4 Request signing / replay protection

The original ask mentions "cryptographic request-signing middleware." Concretely, this already exists in the one place it actually matters: **webhook signature verification** (`webhook-flutterwave`, per `docs/06` §9 — signature-verified, idempotent via `provider_event_id`, rejects unsigned/mismatched outright). For ordinary client → Edge Function calls, the JWT itself _is_ the request-authentication mechanism (§2.3) — layering an additional HMAC request-signing scheme on top of an already-verified bearer token adds real client-side key-management complexity (where does the RN app get a signing key it can't leak?) without closing a gap the JWT doesn't already close. **Recommendation: skip generic request-signing for authenticated calls; it's solving a problem this architecture doesn't have.** Keep webhook signing as the one place it's genuinely necessary (a webhook has no user session to verify against).

## 3. Rate limiting & DoS mitigation

**Real gap, distinct from what's already built.** `docs/06` §6's rate limiting (message-per-minute caps, duplicate-content detection) is a **fraud/economic control** — it governs whether an escrow _releases as earnings_, not whether a request is _accepted at all_. Nothing today stops a script from calling cheap, credit-free endpoints (`mark-thread-read`, `find-user-by-phone`, `find-users-by-phones`, `web-send-otp`, `get-public-pricing`) at high volume — Supabase's own platform-level rate limits are the only backstop, and those are generic (not tuned to this app's actual abuse shapes: phone-number enumeration via `find-user-by-phone`, OTP-bombing via `web-send-otp`).

**Fix — Postgres-native, not Redis, consistent with §1's architecture correction:**

- One small table, `rate_limit_buckets (key text, window_start timestamptz, count int, primary key (key, window_start))`, and one `SECURITY DEFINER` helper (`fn_check_rate_limit(p_key text, p_max int, p_window_seconds int) returns boolean`) that does the increment-and-check atomically (`INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count`), called at the top of the specific Edge Functions that need it before any other work happens. This is the token-bucket/fixed-window pattern the original ask wants, implemented in the datastore this app already has a connection pool to, with zero new infrastructure to operate, monitor, or pay for.
- Apply it first to the genuinely exposed endpoints: `web-send-otp` (per-phone-number and per-IP), `find-user-by-phone`/`find-users-by-phones` (per-caller, since this is also the app's phone-enumeration surface — `docs/18` §A4 already flagged the exact-match-only lookup as an anti-enumeration property; a rate limit on _how fast_ someone can enumerate is the missing second half of that mitigation), and `send-message`/`buy-credit` (per-caller, as defense-in-depth beyond the natural cost-based throttle insufficient credit already provides).
- **Payload size**: Supabase Edge Functions already reject oversized request bodies at the platform level (a hard limit exists regardless of app code); the app-controllable equivalent that's actually missing is a message-body length ceiling _before_ it reaches billing logic — `message_max_words`/`message_audio_max_seconds` already do exactly this for the fields that matter (confirmed in `fn_send_message`). No separate "file size at the gateway" control is needed beyond what create-*-upload-url's signed-URL scoping + Supabase Storage's own bucket size limits already provide.
- **Heartbeat/dead-connection timeouts**: Supabase Realtime already manages this at the platform level (it drops idle/dead sockets on its own schedule) — not a control this app's code can or needs to add on top.

## 4. Data sanitization & injection prevention

**Injection surface is already effectively closed** (§1's table) — every DB write goes through parameterized RPC calls or the query builder, never string-built SQL. This is a stronger guarantee than "we used an ORM," since there's no dynamic query construction anywhere to audit in the first place.

**Real gap: request-shape validation is ad hoc, not systematic.** Every Edge Function checked (`send-message`, `set-thread-payer`, `set-thread-muted`, etc.) does its own hand-written `typeof x !== 'string'` / `!UUID_RE.test(x)` checks inline — correct in each individual case audited, but inconsistent in shape across ~40 functions, easy to miss a field on a new function, and not centrally reviewable. **Recommendation: adopt Zod**, exactly as proposed, for exactly this reason — it's a small (~15KB), dependency-light, widely-used library (satisfies CLAUDE.md rule #10's "stay lite" bar the way a heavier validation framework wouldn't), and this app's own web-app half (`docs/12`/marketing site) may already pull it in transitively via Next.js tooling, worth checking before assuming it's a net-new dependency for the repo as a whole.

- One schema per Edge Function request body, colocated with that function (`supabase/functions/<name>/schema.ts`), parsed with `.safeParse()` as the very first line after auth, returning a uniform `400 invalid_request` with the Zod error's field path on failure — replacing the current per-function hand-rolled checks, not layering on top of them.
- This is genuinely a "build now" item independent of §0's E2EE decision — low-risk, mechanical, improves consistency, and directly closes the "validate every incoming packet strictly matches expected types" ask as written.

## 5. Secrets & configuration management

**Already correctly built, verified directly**, not assumed: `_shared/auth.ts` reads `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` exclusively via `Deno.env.get()`, with an explicit `server_misconfigured` failure (not a silent fallback) if either is missing — the exact "no secrets hardcoded, strict `process.env` validation" pattern the original draft asks for, already the standing convention this whole codebase follows (confirmed: zero hardcoded API keys/secrets found in a full grep of `supabase/functions`). The two-step PIN pepper (`TWO_STEP_PIN_PEPPER`) and the admin dashboard's Argon2id password hashing (`docs/14`, `20260920111500_admin_rbac_functions.sql`) both already follow this same pattern.

**One clarification worth stating explicitly, since it's a common false-positive**: `EXPO_PUBLIC_SUPABASE_ANON_KEY` appearing in `eas.json`/the built client bundle is **not a secret leak** — the anon key is _designed_ to be public (it identifies the project, not a privileged caller), and every actual security boundary sits behind it in Postgres RLS and the `SECURITY DEFINER` function grants (`docs/01` §3). Don't let a naive secret-scanner flag this as a finding; the thing that would actually be catastrophic is the **service-role key** reaching client code, which the §2.3 verification step above checks for directly.

## 6. Data at rest — the honest version of "even your database cannot read them"

Real, current state: Postgres/Supabase Storage encryption-at-rest (disk-level, standard on Supabase, already true today) plus RLS restricting who can `SELECT` a message row to the two thread participants and `service_role`. That's real and worth stating in updated security-posture copy (§0, Path 1).

**What that does _not_ mean, and shouldn't be implied to mean**: anyone holding valid `service_role` credentials — a legitimate InvolveMe operator via Supabase Studio, or an attacker who somehow obtained that key — **can** read message content in plaintext, by design, because moderation needs to. This is the direct, unavoidable consequence of §0's decision to keep server-side moderation. Column-level application encryption (e.g., `pgcrypto` on `messages.body`) would not change this meaningfully unless the decryption key is also kept out of the moderation path's reach — and the moderation path needs plaintext, so encrypting the column and then decrypting it right back before every moderation call adds real complexity (key management, rotation, a new failure mode where a KMS outage blocks message sends) for a security property (protection from a compromised service-role key) that a determined attacker with that credential could work around anyway by reading the decrypted value the moderation call itself produces in memory. **Recommendation: don't build column-level encryption for message content under Path 1** — it's a lot of new surface area for a guarantee it can't actually deliver while moderation exists. The real mitigation for "a leaked service-role key is catastrophic" is operational (secret rotation policy, minimizing who/what holds that key, the §2.3 client-bundle check), not cryptographic.

**Where column-level encryption _is_ worth it, and isn't built yet**: fields that never need to be read by any server-side process in plaintext for a legitimate app function — there currently are none obvious in this schema beyond what `kyc_records.bvn_or_nin_hash` already handles correctly (a hash, not even reversible encryption, since BVN/NIN only ever needs to be _compared_, never displayed — confirmed already built per `docs/07` §5).

## 7. Cryptography — held pending §0

Everything from the original ask under "End-to-End Encryption" (X3DH handshakes, Double Ratchet, identity key verification, ephemeral session key rotation) is real, correctly-named Signal Protocol terminology and would be implemented correctly using `libsodium`/`libsignal` bindings if built — but per §0, this is a Path 2 decision, not default work. Not scoped further here until that decision is made; a real X3DH/Double Ratchet implementation deserves its own dedicated doc at the same weight as `docs/11` once (if) Path 2 is chosen, covering key storage on-device (`expo-secure-store`/Keychain/Keystore, never AsyncStorage), the multi-device fan-out problem, and a moderation-redesign plan — not something to sketch as a subsection here.

## 8. Proposed `CLAUDE.md` addition — refined from the draft

The originally drafted rules are a reasonable instinct but two don't quite match this codebase as built; refined version:

```markdown
## Security & Hardening Rules

- Message/status/media content is encrypted in transit (TLS, Supabase-managed) and at rest
  (Postgres/Storage disk encryption, Supabase-managed) — this is NOT end-to-end encryption,
  and no UI copy, marketing material, or ToS language may imply otherwise unless real E2EE
  (docs/19 §0 Path 2) is actually built. Server-side content moderation depends on plaintext
  access; do not encrypt message content in a way that breaks it without an explicit decision
  to redesign moderation first.
- Every Edge Function request body is validated with a Zod schema (`safeParse`, colocated
  `schema.ts` per function) before any other logic runs — no hand-rolled type checks for new
  functions once docs/19 §4's migration is complete.
- No SECURITY DEFINER function or Edge Function ever builds a SQL string by concatenating or
  interpolating request data — RPC calls and the Supabase query builder's parameterized filters
  only, no exceptions.
- No secrets, API keys, or service-role credentials are ever hardcoded; every one is read via
  `Deno.env.get()`/`process.env` with an explicit failure (never a silent fallback) if missing.
  `EXPO_PUBLIC_*` values are the one deliberate exception — those are meant to be public;
  everything else is not.
- The Supabase service-role key must never reach client-bundled code, ever — verify this on any
  change that touches how a client authenticates or calls an Edge Function.
- Any Edge Function accepting unauthenticated or low-cost-to-call input (OTP send, phone lookup,
  public pricing) must be rate-limited via `fn_check_rate_limit` (docs/19 §3) — Postgres-based,
  not a new external dependency (Redis or otherwise) without a specific, documented reason the
  Postgres-native approach can't scale to.
- User-facing PIN/password verification uses a pepper or salt kept out of the database the
  hashed value lives in (Edge Function secret, not a DB column) — see two_step_pin_hash and the
  admin dashboard's Argon2id password hashing for the two existing correct patterns; match one
  of them, don't invent a third.
```

## 9. Build order

**Tier A — ✅ built, deployed, and shipped:**

1. **Zod request validation across Edge Functions (§4)** — done. `_shared/validate.ts` (`parseBody`/`requiredString`/`requiredUuid`/`requiredBoolean`) plus a per-function schema for every function with a validatable body — all ~40 Edge Functions reviewed; the handful with no body (`get-public-pricing`, `list-banks`, cron-only functions) or an existing correct non-Zod helper (`isValidPinFormat`, `EXTENSION_BY_KIND`) deliberately left as-is, documented inline why. `webhook-flutterwave` deliberately untouched — its existing optional-chaining style already fails safe on an unexpected provider payload shape, which is the correct posture for a webhook. Zero regressions: full `test:functions` suite (39 files) re-run clean after the change.
2. **Postgres-native rate limiting (§3)** — done. `20260926150000_api_rate_limiting.sql`: `rate_limit_buckets` table + `fn_check_rate_limit` (atomic fixed-window counter, one `INSERT ... ON CONFLICT` per check) + `fn_cleanup_rate_limit_buckets` on an hourly `pg_cron` job. Wired into `web-send-otp` (per-phone 3/10min, per-IP 10/10min — closing that function's own previously-documented gap), `find-user-by-phone` (30/min per caller), `find-users-by-phones` (5/hour per caller — a sync is an occasional action, not a per-minute one), `send-message` (60/min per caller, defense-in-depth beyond the natural credit-cost throttle), `buy-credit` (10/hour per caller, bounding real Flutterwave API cost, not just app load).
3. **Two verification checks (§2.1/§2.3/§5)** — done, not just assumed: `curl -sI` against both a live Edge Function and the REST endpoint confirmed `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` present on both. Grepped the actual built mobile JS bundle (`apps/mobile/dist`, not just source) for the real service-role key value and for the string `service_role` — the key itself: absent. The one `service_role` string match found was traced to `@supabase/supabase-js`'s own bundled JSDoc comment text ("never expose your `service_role` key in the browser") — a warning string, not a credential.
4. **`CLAUDE.md` Security & Hardening Rules section** — added, refined from this doc's own §8 draft.

**Tier B — needs your decision, not started:**

5. TLS certificate pinning on the mobile client (§2.1) — real effort (native rebuild required, not OTA-able), worth scoping in its own pass once you confirm you want it prioritized now vs. later.
6. §0's E2EE path — Path 1 (update security-posture copy to match what's real, cheap) vs. Path 2 (a genuinely large, separately-scoped crypto + multi-device + moderation-redesign project).

**One unrelated finding surfaced during Tier A's test pass, fixed inline, worth recording:** three test fixture files (`edit-message-function.test.js`, `chat-media-storage-rls.test.js`, `message-delete-function.test.js`) seed threads via a direct `insert into threads (participant_a, participant_b)`, bypassing `fn_start_thread` — safe before Tier C1, but `threads.payer_id` has no column default (by design, see `docs/18` §C1), so a thread seeded this way got `payer_id = null` and every `fn_send_message` call against it started failing with `no_active_payer`. Confirmed via grep that **no production code path** ever inserts into `threads` directly (only `fn_start_thread` does, and it already sets `payer_id` correctly) — this was purely a test-fixture gap, now fixed in all three files.

A second, genuinely pre-existing and unrelated finding, **not fixed** (out of scope for this pass, flagged for its own future fix): `admin-message-pricing-strategy-functions.test.js`'s grants-lock test (`testExecuteGrantsAreLocked`) hardcodes `fn_send_message`'s full signature string for a `has_function_privilege` check — that string is now stale by two migrations (`chat_audio_messages_pipeline` and `free_status_reply_first_message`, both landing earlier this same session, before any of today's work), so that one assertion fails with "function does not exist." This test isn't part of the `test:functions` suite and predates today's changes entirely — confirmed via the test's own comment history, not assumed.
