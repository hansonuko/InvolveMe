# 21 — Real End-to-End Encryption: Technical Design

Follows `docs/20-E2EE-SCOPING.md`'s decisions: no pre-send moderation on E2EE threads, byte-length billing, multi-device-aware schema from day one, Double Ratchet/X3DH implemented from the public spec on `react-native-libsodium` primitives (not a native `libsignal` bridge — this Windows dev environment has no local iOS compile/verify path, so that route would mean repeated real `eas build` cycles just to debug native linking, which the schema/protocol design below avoids needing at all until the feature is ready to actually ship).

**Scope: 1:1 threads only**, same boundary every other structural change this session drew — group chat (`group_threads`/`group_messages`) is a separate, still-kill-switched billing model (`docs/18` §C1's own note) and out of scope here too.

**Status: all 7 build-order steps shipped** (schema migration, prekey Edge Functions, the X3DH/Double Ratchet crypto core, the server-side billing wiring, client integration, the adversarial self-review, and the ToS/Privacy Policy rewrite — see §8; §7 has the review's findings and fixes). What's left is not a build step: your call on an independent (non-AI) review before this reaches real users (§7's own standing recommendation), and the residual gaps §5/§7 already record (editing/forwarding into an E2EE thread not wired, delete-for-everyone not scrubbing envelopes, no safety-number change-detection, native HKDF not vector-verified on-device).

**Step 5 status (shipped):** `apps/mobile/lib/e2ee/identity.ts`, `prekeys.ts`, `sessionStore.ts`, `session.ts` (the `encryptForThread`/`decryptEnvelope` interface §5 called for), `safetyNumber.ts`, and `plaintextCache.ts` (see below — a real addition beyond what §5 originally scoped). `lib/queries/messages.ts`'s `useSendMessage`/`useThreadMessages` are now `e2ee_status`-aware; the thread screen has an "Enable end-to-end encryption" action (overflow menu), a persistent "🔒 Messages here are end-to-end encrypted" banner reusing the payer banner's UI surface (§6), and a "View safety number" screen.

**A real architectural addition found while building this, not originally scoped in §5:** Double Ratchet forward secrecy means a message's decryption key is used once and discarded — this app had no local plaintext message store before this (`useThreadMessages` always rendered directly from what Supabase returned), so without something to persist an already-decrypted plaintext, reopening the app or scrolling back to an old message would find it permanently unreadable the moment the ratchet moved past it. `plaintextCache.ts` (AsyncStorage, no expiry, its own namespace — deliberately not the same thing as `_layout.tsx`'s general 24h-maxAge TanStack Query persister) fixes this: populated on first successful decrypt (recipient side) or at send time (sender side, which never decrypts its own messages at all — no envelope is ever addressed to yourself, docs/21 §2), read from thereafter. No new dependency (CLAUDE.md rule #10) — `@react-native-async-storage/async-storage` was already installed.

**Also found and fixed while building this:** PostgREST returns `bytea` columns as `"\x"+hex` over JSON, not base64 — confirmed live against this project's own REST API. `e2ee_message_envelopes` is the one table a mobile client reads directly (RLS-gated, "owner can read their own envelopes") rather than through an Edge Function's own base64 re-encoding (`fn_base64_encode_nowrap`, docs/21 §3's other functions) — `hexToBytes` (`lib/e2ee/bytes.ts`) decodes it correctly before anything touches key material, exactly the "getting this wrong silently corrupts key material" trap 20260926160000_e2ee_schema.sql's own header comment already warned about.

**Residual gaps, recorded honestly, not silently assumed handled:**

- Editing an e2ee-active message isn't wired client-side yet (the server-side envelope-replacement path shipped in step 4, `fn_edit_message`'s e2ee branch, but `useEditMessage`/the thread screen's edit flow only ever builds a plaintext-body request) — editing an e2ee message from the UI isn't offered yet.
- Forwarding a message _into_ an e2ee-active thread isn't wired either — the server correctly rejects it (`e2ee_envelopes_required`), a visible failure, not a silent leak, but not a working feature yet.
- `delete-message-for-everyone` scrubs `messages.body` (already null for e2ee) and the local plaintext cache, but does **not** scrub the corresponding `e2ee_message_envelopes` ciphertext row server-side — a party who has this device's session state but hadn't yet opened/decrypted that specific message before the "delete" could still decrypt it afterward. Narrow (forward secrecy already closes it for anyone who already saw it), but real.
- The safety-number screen recomputes on each view with no persisted "verified" state and, more importantly, no change-detection alert if a contact's safety number ever changes between visits (a new/compromised key rotating in) — arguably the higher-value half of a real safety-number UX, not yet built.
- Multi-device: `session.ts` resolves "the sender's device" by taking the first active device a user has — correct today (linked devices, docs/12, isn't built), would need real work once it is.
- The native adapter's HKDF path (react-native-libsodium, production) still isn't vector-verified on-device — carried over from step 3, unchanged; still the right item to fold into step 6's on-device pass.

## 1. Cryptographic design

**Per-device identity, not per-user** (docs/20 §2's multi-device-from-day-one decision) — each device a user is signed into generates its own:

- **Identity signing key** (Ed25519) — signs that device's prekeys, proving they were genuinely generated by a device holding this identity.
- **Identity ECDH key** (X25519) — used in X3DH's Diffie-Hellman operations.

Kept as two separate keypairs rather than one dual-purpose key via Ed25519→X25519 conversion (a trick Signal's own XEdDSA uses) — simpler to reason about and implement correctly on `libsodium`'s standard APIs, and avoids relying on a conversion technique that's had cryptographic subtlety concerns raised about it in some outside analysis. Two keys, two clear jobs.

### X3DH (session establishment)

When device A messages device B for the first time:

1. A fetches B's current **prekey bundle**: identity key (X25519 + Ed25519), current signed prekey (+ Ed25519 signature over it, verified against B's identity signing key before trusting it), and one one-time prekey (server marks it consumed atomically on fetch — never reused, see §2).
2. A generates a fresh ephemeral X25519 keypair for this handshake only.
3. A computes the shared secret as HKDF over the concatenation of four DH outputs: `DH(A_identity, B_signedPrekey)`, `DH(A_ephemeral, B_identity)`, `DH(A_ephemeral, B_signedPrekey)`, and `DH(A_ephemeral, B_oneTimePrekey)` (the standard X3DH construction — omit the fourth term if B had no one-time prekey available, a real degraded-but-documented case, see §2's replenishment design).
4. A's first message to B carries A's identity key, A's ephemeral public key, and which one-time prekey id (if any) was consumed — B needs these to independently derive the identical shared secret using its own private key material. None of this is secret; it's exactly what a public key bundle exchange requires.
5. From the shared secret, both sides derive the Double Ratchet's initial root key and begin ratcheting.

### Double Ratchet (ongoing messages)

Standard construction per `signal.org/docs/specifications/doubleratchet`: a **symmetric-key ratchet** advances a chain key forward on every message sent/received (each message gets its own derived key, immediately discarded after use — forward secrecy), and a **DH ratchet** runs a fresh Diffie-Hellman exchange whenever the conversation's sending direction flips, mixing new entropy into the root key (post-compromise security — a later exchange heals a past key compromise).

**Out-of-order delivery** is a real, easy-to-get-wrong part of the spec, not an edge case to skip: a receiving chain must cache derived-but-not-yet-used message keys (messages that arrive out of sequence) for a bounded window, so a late-arriving message can still be decrypted with the key that was skipped past. This needs its own dedicated test coverage (§7).

### Primitives (all via `react-native-libsodium`, already-audited, actively-maintained RN bindings — confirmed live on npm, not a Node-only package)

- X25519 for every DH operation.
- Ed25519 for prekey signatures.
- HKDF (`crypto_kdf` family) for all key derivation.
- XChaCha20-Poly1305 (AEAD) for message encryption — authenticated, so a tampered ciphertext is rejected rather than silently corrupted.

## 2. Schema

All public key material is exactly that — **public**, safe to be broadly RLS-readable (identity keys and prekeys are not secrets; the private halves never leave a device, never touch the server, stored only in `expo-secure-store`).

```sql
-- One row per registered device. Today, in practice, exactly one active
-- row per user (no multi-device UI exists yet — docs/12) — but every
-- write path below is already keyed by device, not by user, so linked-
-- devices can ship later without a schema change here.
create table e2ee_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  device_label text,                    -- display only, e.g. "iPhone"
  identity_key_ed25519 bytea not null,  -- public
  identity_key_x25519 bytea not null,   -- public
  registered_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  revoked_at timestamptz                -- null = active
);

-- Signed prekeys rotate periodically; old rows kept through their own
-- expires_at so an in-flight X3DH handshake started just before rotation
-- doesn't fail.
create table e2ee_signed_prekeys (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references e2ee_devices(id),
  key_id integer not null,       -- wire-format sequence number, not the DB id
  public_key bytea not null,
  signature bytea not null,      -- Ed25519 signature by this device's identity key
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Pool of one-time prekeys — consumed atomically on first fetch (see
-- fn_fetch_prekey_bundle, §3), replenished by the owning device when its
-- own remaining count runs low (a dedicated Edge Function it polls/checks
-- on launch, not covered in detail here — mechanical, low-risk).
create table e2ee_one_time_prekeys (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references e2ee_devices(id),
  key_id integer not null,
  public_key bytea not null,
  consumed_at timestamptz        -- null = available
);

create unique index e2ee_one_time_prekeys_available_idx
  on e2ee_one_time_prekeys (device_id, key_id) where consumed_at is null;

-- A thread's E2EE state — additive, defaults preserve every existing
-- thread's current plaintext behavior exactly, same "nullable/defaulted,
-- zero migration risk" discipline threads.payer_id already established
-- (docs/18 §C1).
alter table threads add column e2ee_status text not null default 'off'
  check (e2ee_status in ('off', 'active'));
-- 'off': legacy plaintext path, completely unchanged. 'active': every new
-- message in this thread is encrypted, no exceptions, no per-message
-- opt-out — an all-or-nothing thread-level switch, not a per-message one
-- (docs/20 §9's mixed-history question, resolved: a thread transitions
-- once, doesn't flicker message-to-message).

-- The actual encrypted payload — separate from `messages`, because a
-- single logical message can have MULTIPLE envelopes (one per recipient
-- device, once multi-device is real) each independently ratchet-encrypted
-- under a different session. `messages` itself stays the thread-timeline/
-- billing unit; this table is purely the ciphertext + Double Ratchet
-- header per (message, recipient device) pair.
create table e2ee_message_envelopes (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id),
  recipient_device_id uuid not null references e2ee_devices(id),
  ciphertext bytea not null,
  ratchet_public_key bytea not null,     -- Double Ratchet header field
  previous_chain_length integer not null,-- Double Ratchet header field
  message_number integer not null,       -- Double Ratchet header field
  -- Present only on an envelope that's the FIRST message of a brand-new
  -- X3DH session with this specific recipient device:
  x3dh_sender_identity_key bytea,
  x3dh_sender_ephemeral_key bytea,
  x3dh_one_time_prekey_id integer,
  created_at timestamptz not null default now()
);

create index e2ee_message_envelopes_message_id_idx on e2ee_message_envelopes (message_id);
create index e2ee_message_envelopes_recipient_device_idx
  on e2ee_message_envelopes (recipient_device_id);
```

`messages.body` stays as-is for `e2ee_status = 'off'` threads. For `'active'` threads, `body` is written as `null` (or an empty string, TBD at implementation time against the existing `not null`/length constraints on that column) — the real content lives exclusively in `e2ee_message_envelopes`, which RLS restricts to `recipient_device_id`'s owning user and the sender (mirroring `escrows_select_participant`'s existing shape, keyed to device ownership instead of payer/payee).

## 3. Server-side functions — what changes, what doesn't

**Unchanged**: thread creation, blocking, muting, the payer role (`docs/18` §C1), read receipts, `fn_start_thread`. None of this touches message content.

**New, all `SECURITY DEFINER`, `service_role`-only per CLAUDE.md rule #11**:

- `fn_register_e2ee_device` — inserts an `e2ee_devices` row + initial signed prekey + initial one-time prekey batch, called once per device on first E2EE setup.
- `fn_fetch_prekey_bundle(p_target_user_id)` — the X3DH handshake's read path: returns the target's identity keys + current signed prekey + **atomically claims one one-time prekey** (`update ... set consumed_at = now() where device_id = $1 and key_id = (select key_id from e2ee_one_time_prekeys where device_id = $1 and consumed_at is null order by key_id limit 1 for update skip locked) returning public_key, key_id` — row-locked exactly like every wallet operation in this app already is, so two concurrent handshake attempts can't claim the same one-time prekey twice).
- `fn_replenish_one_time_prekeys` — a device tops up its own pool; self-only (caller must own the device).
- `fn_enable_e2ee(p_thread_id)` — flips `threads.e2ee_status` to `'active'`, participant-only, idempotent.

**Changed**: `fn_send_message` gains an `e2ee_status`-aware branch:

- If the thread is `'off'`: **completely unchanged** — same plaintext path, same word-count billing, same moderation call, same duplicate-content check in `fn_release_escrow`. Every existing thread and every existing test keeps working exactly as today.
- If the thread is `'active'`: the request carries envelope ciphertexts (one per recipient device) instead of a plaintext `body`. Billing switches to **ciphertext byte length** (§4). The moderation call is skipped entirely (docs/20 §3's decision — nothing to moderate, there's no plaintext to read). `fn_release_escrow`'s `similarity()` duplicate-content check is skipped for escrows tied to an `'active'`-thread message (docs/20 §5's accepted gap) — metadata-only fraud signals (rate limits, collusion detection) are untouched and keep working exactly as today, since neither reads message content.

**Shipped** (`20260926170000_e2ee_send_message_billing.sql`, `supabase/tests/e2ee-send-message-billing.test.js` — 33 assertions). Two implementation notes worth recording:

- `fn_release_escrow` needed **zero code changes** — its duplicate-content check calls `similarity(body, ...)`, and an `'active'`-thread message's `body` is `null`; `similarity(null, x)` returns `null` in Postgres, and `if null then` is false in plpgsql, so the "skip" described above falls out of NULL propagation, not an explicit branch. Verified live (a direct query) and with a regression test (`testDuplicateContentNeverFlagsE2ee`) before trusting it, not assumed.
- Media is rejected outright on an `'active'` thread (`e2ee_media_not_supported`) rather than silently allowed through unencrypted — out of scope for this pass, not a documented gap here before.
- Envelope recipient devices are validated against the OTHER participant's registered, non-revoked `e2ee_devices` rows before any field is trusted — the same anti-enumeration/ownership posture `fn_fetch_prekey_bundles` already established.
- `fn_edit_message` gained the identical envelope-replacement treatment: an edit re-encrypts as a fresh envelope per recipient device (Double Ratchet has no "edit in place"), checked against the frozen `credits_charged` exactly like the word-count path. Found and fixed in passing: its three `message_word_block_size`/`message_base_credits`/`message_max_words` lookups had no `currency` filter despite `pricing_config`'s PK being `(key, currency)` since the multicurrency migration — harmless only because this app is NGN-only in practice, fixed since it would have shipped inconsistent with the new byte-length lookups added in the same diff.

## 4. Billing — byte-length, server-verified without decryption

Every envelope for the same logical message encrypts the identical plaintext, so every envelope's ciphertext length is identical up to the DR header's fixed field sizes (which this design controls precisely) — the server can measure **any one envelope's ciphertext length** and get an unambiguous, client-can't-lie-about-it number, no matter how many recipient devices exist.

```
ciphertext_overhead_bytes = 16 (Poly1305 AEAD tag)  -- header fields stored as separate columns, not packed into ciphertext
byte_count               = ciphertext_length - ciphertext_overhead_bytes
byte_blocks               = ceil(byte_count / message_byte_block_size)
credits_charged           = message_byte_base_credits × greatest(byte_blocks, 1)
```

New `pricing_config` keys (`message_byte_block_size`, `message_byte_base_credits`, `message_max_bytes`), same "config not constants" discipline CLAUDE.md rule #9 requires — mirroring `message_word_block_size`/`message_base_credits`/`message_max_words`'s exact existing shape, substituting bytes for words. **The actual tier numbers need a real calibration pass before this migration ships** (docs/20 §4 already flagged this as its own reviewed decision, not a rubber stamp) — a reasonable starting point is sizing `message_byte_block_size` so a "typical" ~50-word English message (roughly 250-300 UTF-8 bytes) lands close to today's 2-credit floor, but that's a proposal to confirm, not a default to assume.

Shipped with `message_byte_block_size = 300`, `message_byte_base_credits = 2` (a ~50-word/~300-byte message lands at exactly one block, matching `message_base_credits`'s own floor), and `message_max_bytes = 3000` (mirrors `message_max_words = 500`'s own 10-block ceiling: 500/50 = 10 blocks × 300 bytes/block). Explicitly a calibration starting point, not a final tuned number — still needs the real calibration pass this paragraph called for, now against live usage data instead of a guess.

`fn_edit_message`'s `edit_would_increase_cost` check gets the identical byte-length treatment — same problem, same fix, applied consistently.

## 5. Client architecture (`apps/mobile/lib/e2ee/`)

| Module              | Responsibility                                                                                                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity.ts`       | Device identity keypair generation (first E2EE setup), stored via `expo-secure-store` (already an installed dependency — no new native module for this specific piece).                                                                             |
| `prekeys.ts`        | Signed/one-time prekey generation, upload, low-pool replenishment check.                                                                                                                                                                            |
| `x3dh.ts`           | Session establishment from a fetched prekey bundle — the four-DH computation in §1.                                                                                                                                                                 |
| `doubleRatchet.ts`  | The ratchet state machine itself: encrypt, decrypt, DH ratchet step, skipped-message-key cache for out-of-order delivery. The single highest-risk file in this entire project — see §7.                                                             |
| `sessionStore.ts`   | Persists per-(own device, peer device) ratchet session state — chain keys, skipped-key cache — in `expo-secure-store`. This state is exactly as sensitive as the identity key; it never leaves the device, never reaches the server in any form.    |
| `safetyNumber.ts`   | Derives a human-verifiable fingerprint from both parties' identity keys — the actual key-verification UI (Signal/WhatsApp's "verify this contact" screen), giving users a real way to detect a MITM'd key exchange rather than trusting it blindly. |
| `plaintextCache.ts` | Durable, no-expiry local store of already-decrypted plaintext, keyed by message id (step 5 addition — see status note below for why this exists and isn't optional).                                                                                |

**Designed behind one clean interface** (`encryptForThread(threadId, plaintext)` / `decryptEnvelope(envelope)`) so that if InvolveMe ever gets real native-build tooling and wants to swap this module's internals for a bridge to Signal's actual audited `libsignal-client` later (docs/20 §1's noted future hardening path), that's a contained swap behind the same interface — not a rewrite of `fn_send_message`, the schema, or the UI built on top of it.

**Integration points**: `useSendMessage`/`useThreadMessages` (`lib/queries/messages.ts`) gain an `e2ee_status`-aware branch, encrypting before the `send-message` call and decrypting after a Realtime delivery or fetch, symmetric to the server-side branch in §3.

## 6. Migration / mixed-history UX

A thread starts `'off'` (every existing thread, forever, unless explicitly upgraded) and moves to `'active'` via `fn_enable_e2ee` once **both** participants' current devices have published a prekey bundle — a real X3DH handshake completes as part of enabling it, not just a flag flip. Once `'active'`, it stays active — no flickering back to plaintext, no per-message opt-out, matching §2's schema note. The existing static/live payer banner (`docs/18` §C1) already established the pattern of a persistent thread-level status strip in this exact screen; a parallel "this conversation is now protected" indicator reuses that same UI surface rather than inventing a new one.

## 7. Testing strategy — this is where the real engineering rigor has to live

- **Round-trip correctness**: alternating senders (forces DH ratchet steps), long sequences (chain-key advancement), session bootstrap from a fresh X3DH handshake.
- **Out-of-order delivery**: messages arriving 2-3-1 must all still decrypt correctly via the skipped-message-key cache — a real, spec-mandated case, not an edge case to skip.
- **Forward secrecy, tested by construction**: after a chain key is used and discarded, assert it is actually gone (not just unused) and that an attacker with a later key cannot derive it backwards.
- **Tampered-ciphertext rejection**: AEAD authentication must reject a modified envelope outright, never partially decrypt.
- **Billing**: the same ledger-conservation + concurrency test discipline CLAUDE.md already requires for every balance-mutating function, applied to the new byte-length path in `fn_send_message`.
- **A dedicated adversarial self-review pass** — a fork tasked specifically with trying to break the `doubleRatchet.ts`/`x3dh.ts` implementation (nonce reuse, key/role confusion, replay, downgrade attacks) before this is considered done, separate from normal functional testing. Per the standing recommendation in `docs/20`: this is necessary but not sufficient — a genuinely independent (non-AI, or at least a fresh, unbiased) review before this touches real user data is still the right bar for something this consequential, and that call is yours to make once there's real code to point someone at.

**Step 3 status (shipped):** `apps/mobile/lib/e2ee/` now has `sodiumProvider.ts` (the interface), `hmacSha256Rfc2104.ts` + `hkdfRfc5869.ts` (hand-rolled, RFC-4231/RFC-5869-vector-verified — see `supabase/tests/e2ee-hkdf-rfc5869.test.ts`), `x3dh.ts` + `doubleRatchet.ts` (implemented from the public specs, `supabase/tests/e2ee-crypto-core.test.ts`'s 21 assertions cover every case listed above), and two adapters: `sodiumProviderTestAdapter.ts` (libsodium-wrappers-**sumo** — the plain "libsodium-wrappers" package's actual runtime is missing box/sign/scalarmult/AEAD/hmac entirely despite its own `.d.ts` claiming otherwise, verified live) and `sodiumProviderNative.ts` (`react-native-libsodium`, production).

**One residual gap, recorded honestly rather than papered over:** `sodiumProviderNative.ts`'s HKDF calls (`_unstable_crypto_kdf_hkdf_sha256_extract/expand`, react-native-libsodium's real native binding) have **not** been verified against the RFC 5869 test vectors — doing that requires the actual on-device/RN runtime, which this Node-only session can't reach. Only the Node test adapter's hand-rolled HKDF path is vector-verified so far. Before this reaches real users, run a one-off on-device check comparing the native adapter's `hkdfExtract`/`hkdfExpand` output against the same RFC 5869 vectors already in `e2ee-hkdf-rfc5869.test.ts` — folding this into Step 6's adversarial review pass is the natural place for it.

**Step 6 status (shipped):** the adversarial pass ran (fork, per this section's own instruction), targeting `x3dh.ts`/`doubleRatchet.ts` plus the surrounding orchestration (`session.ts`, `sessionStore.ts`) it could undermine even if the core itself were correct. It found real bugs, not theoretical ones — reproduced live, not just argued for:

- **[CRITICAL, fixed] Concurrent encrypts for the same device raced to the same chain position, reusing an AEAD key+nonce across two different real plaintexts** — `session.ts`'s load→ratchet→save sequence had nothing serializing two overlapping calls for the same device (a double-tap Send, a retry racing the original). Reproduced: two different plaintexts both landed on `messageNumber: 0` under the identical key/nonce — an observer holding both ciphertexts (the server always does) can XOR them to recover `plaintextA XOR plaintextB` directly. `doubleRatchet.ts`/`x3dh.ts` themselves were not at fault — pure, stateless, correct for any single sequential call chain; the bug was entirely in the orchestration layer trusting the caller to serialize.
- **[HIGH, fixed] The same missing lock let a losing concurrent decrypt's stale-based save overwrite a winning one's** — a forward-secrecy violation: an already-consumed message key could resurface (or, depending on exact interleaving, a successfully-decrypted message's advance could be silently lost) in the persisted state.
- **[HIGH, fixed] Redelivering the original session-establishing envelope reset an already-advanced session** — `decryptEnvelope` used to bootstrap (`initRatchetAsBob`) unconditionally whenever an envelope carried X3DH fields, with no check for an existing session. A redelivered copy of that same original message (realistic under normal at-least-once delivery/reconnect behavior, not a contrived attack) would desync the session from whatever the sender had actually moved on to.

All three fixed with `deviceLock.ts` (a real per-`(threadId, deviceId)` async mutex serializing `session.ts`'s critical sections) plus a one-condition guard in `decryptEnvelope` (`if (!session && ...)` before bootstrapping). Verified in `supabase/tests/e2ee-concurrency-fix.test.ts` (9 assertions — before/after for both races) and `e2ee-bootstrap-replay-fix.test.ts` (6 assertions, including a negative-control run proving the test actually fails against the old unconditional-bootstrap logic, not just trivially passing).

**A fourth issue found while investigating the review's more speculative note** that `sessionStore.ts`'s peer-device-only keying could let two threads with the same contact share one ratchet session: checking `threads`' own schema confirmed this is reachable, not just theoretical — `threads_participants_unique unique (participant_a, participant_b)` only constrains the exact ordered pair, not its reverse, so both sides independently starting a conversation (before either's client has seen the other's already-created thread) can create two separate threads between the same two people. **Not fixed here** — `fn_start_thread` is pre-existing, unrelated to E2EE, out of this step's scope — but session storage is now keyed by `(threadId, peerDeviceId)` rather than `peerDeviceId` alone as defense-in-depth regardless of whether that specific race is ever hit: a session belongs to one conversation, not "everything with this device," and there's no principled reason two threads should share one ratchet's sequential chain position even setting the duplicate-thread question aside. Flagging `fn_start_thread`'s asymmetric uniqueness check as a real, separately-worth-fixing bug for whenever someone picks it up.

Per this section's own standing instruction: this pass is necessary but not sufficient. A genuinely independent (non-AI, or at least fresh-eyes) review before this touches real user data is still the right bar for something this consequential.

**Decision (session 36, 2026-09-26):** ship on the adversarial AI pass alone for now, given resource constraints — an independent review stays a backlog item, to be picked up before this handles either a much larger user base or higher-stakes usage than it does today, not before this initial rollout.

## 8. Build order

1. Schema migration (§2) — additive, zero risk to existing threads, safe to ship alone first.
2. `e2ee/identity.ts` + `prekeys.ts` + the three new Edge Functions (§3) — key generation and publishing, no encryption yet, independently testable.
3. `x3dh.ts` + `doubleRatchet.ts` (§1, §7) — the crypto core, built and tested in complete isolation from the app (pure functions, round-trip tests, no UI, no server calls) before anything else touches it.
4. `fn_send_message`'s `e2ee_status`-aware branch + byte-length billing (§3, §4) — the server-side wiring, once the client crypto core is proven correct in isolation.
5. Client integration (`useSendMessage`/`useThreadMessages`, §5) + the enable-E2EE flow + safety-number UI.
6. Adversarial self-review pass (§7), then your call on an independent review before this reaches real users.
7. ToS/Privacy Policy rewrite (`docs/07` §4/§5's current no-E2EE disclosure becomes false once this ships — needs updating in the same release, not after).

Ready to start at step 1 on your go-ahead.
