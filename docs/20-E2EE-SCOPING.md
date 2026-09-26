# 20 — Real End-to-End Encryption: Scoping

**Status: three gating decisions made (§11), detailed technical design in progress. Nothing built yet.** This is `docs/19-SECURITY-HARDENING-SCOPING.md` §0's "Path 2" — you've said you want it. This doc is what Path 2 actually costs, checked against this app's real schema and functions, not a generic "how to add E2EE" writeup. Two of the findings below (§4, §5) are not things a generic E2EE guide would ever mention, because they're specific to InvolveMe billing by message content.

**Decisions locked in (2026-09-26), all matching this doc's own recommendation:**

- §3 (moderation): **no pre-send moderation** — reactive reporting (existing `user_reports`/blocking) + metadata-only fraud signals (rate limits, collusion detection), matching what Signal/WhatsApp actually do for E2EE chats.
- §4 (billing): **byte-length billing** replaces word-count billing — server-verifiable without decryption, closes the client-trust exploit. Treated as its own real `docs/03` formula change, not a side effect.
- §2 (multi-device): **design multi-device-aware from day one**, even though `docs/12` (linked devices) itself ships later — avoids a costly partial rebuild.

## 0. What "real E2EE" actually means, restated precisely

Signal Protocol-grade E2EE means: the server can route a message (knows sender, recipient, thread, timestamp, byte size) but **cannot read its content under any circumstance** — not via a bug, not via a subpoena, not via an admin with full database access. That last part is the whole point, and it's also what makes two things this app already does today structurally impossible to keep as they are: **server-side content moderation** and **server-computed word-count billing**. Both currently read the plaintext body inside the same transaction that does other work. Under real E2EE, neither can, ever again, for any message sent after encryption goes live.

This doc assumes the crypto itself will be built correctly (§1 — use a vetted library, don't hand-roll). The actual hard part, and the reason this is a multi-week project and not a library integration, is redesigning the four things bolted to "the server can read the message" that this app's whole economic and safety model currently depends on.

## 1. The cryptographic core (standard, not InvolveMe-specific)

- **X3DH** (Extended Triple Diffie-Hellman) for initial session establishment between two users who've never messaged — needs each user to publish an identity key, a signed prekey, and a batch of one-time prekeys (public parts only) to the server, which is a plain, non-secret lookup table (safe to store in Postgres, RLS-readable by anyone, same threat model as a phone-book entry).
- **Double Ratchet** for per-message keys with forward secrecy (compromising today's key doesn't expose yesterday's messages) and post-compromise security (a later key exchange heals a past compromise).
- **Library research done directly against npm's registry and GitHub, 2026-09-26 — the honest finding: there is no mature, widely-adopted, production-grade Double Ratchet library for React Native to just install.** This is a real fork in the road, not a detail:
  - **Signal's own `@signalapp/libsignal-client`** is actively maintained (published 8 days before this was written) and is the actual audited code Signal's own apps run — the gold standard for correctness. But it ships as a Node.js native addon (`node-gyp-build`, N-API) built for Node/Electron, **not React Native** — RN doesn't run a Node native-addon ABI. A GitHub search for community RN wrappers around it turned up only unofficial, very-low-adoption projects (single-digit stars, several with signs of being unfinished/abandoned scaffolds) — nothing at the maturity level you'd trust for a financial app's message security.
  - **The TypeScript/JS Double Ratchet implementations that do exist** (`double-ratchet-ts` on npm — last published 2022, 3+ years stale; `TICESoftware/double-ratchet.js`, `irislib/nostr-double-ratchet` on GitHub — 10 and 24 stars respectively, niche/small) are all either abandoned or too small/unaudited to be the sole foundation for real user message security.
  - **What IS actively maintained and genuinely React-Native-native**: the underlying cryptographic _primitives_ — `react-native-libsodium` (real RN bindings, not a Node addon, actively published) and `libsodium-wrappers` — giving audited Curve25519 ECDH, AEAD encryption, and HKDF. What's missing is the _protocol layer_ (the ratchet state machine itself) built on top of them.
  - **The realistic choice is therefore between two genuinely different projects, not one:**
    - **(a) Build a native bridge to Signal's real `libsignal-client`** (JSI/TurboModule wrapping its Rust/C core for iOS+Android) — maximum correctness confidence (it's literally Signal's own audited code), but this is a substantial, specialized native-engineering undertaking in its own right, arguably bigger than the rest of this project combined, and needs real Rust/native-bridging expertise to do safely.
    - **(b) Implement the Double Ratchet protocol directly in TypeScript, against the public Signal specification (signal.org/docs/specifications/doubleratchet, /x3dh), using `react-native-libsodium`'s audited primitives for every actual cryptographic operation** — the primitives are trustworthy; the ratchet _state machine_ (key derivation sequencing, out-of-order/skipped-message handling, session lifecycle) is original code that needs careful, spec-faithful implementation and real testing before it's trusted with anything.
  - **Recommendation: (b).** Given this project's actual scale (no dedicated Rust/native-crypto engineering resource, per everything else built this session), (a) is not realistically achievable at the quality bar it would need. (b) is real, serious cryptographic engineering — not "hook up a library" — and should not proceed to real users without a genuine security review of the ratchet implementation specifically, separate from the rest of this project's usual review process. This is the single highest-risk technical component of the whole effort; worth being honest about that rather than understating it.
- **Key storage**: `expo-secure-store` is **already an installed dependency** (`apps/mobile/package.json`) — the right primitive (iOS Keychain / Android Keystore backed), no new package needed for this part specifically.

## 2. The multi-device dependency — a real sequencing decision

WhatsApp/Signal's multi-device model gives every logged-in device its own identity key and fans out each message encrypted separately per device. `docs/12-LINKED-DEVICES-WEB-SCOPING.md` — **this app's multi-device support — does not exist yet**, and per `docs/00-SESSION-HANDOFF.md` has been deferred three times already.

This forces a real choice, not a detail to figure out later:

- **(a) Build E2EE single-device-only first, multi-device later.** Faster to a working version, but the protocol shape for "one identity key per user" and "one identity key per device" are different enough that adding multi-device afterward is closer to a second migration than an extension — sessions, key storage, and the UI's "linked devices" model would all need rework.
- **(b) Design multi-device-aware from day one**, even if linked-devices web itself ships later. More upfront design, but the E2EE core only gets built once.

**Recommendation: (b).** Given docs/12 is a real, named, repeatedly-requested future feature (not a hypothetical), building E2EE against a single-device assumption is building something you already know you'll need to partially redo.

## 3. The moderation trade-off — the single gating decision, likely needs legal input, not just an engineering call

`send-message`'s moderation pipeline (`packages/moderation/`) downloads and reads plaintext/raw bytes of every message, image, and voice note server-side, via OpenAI's API — `docs/07-COMPLIANCE-LEGAL.md` §3 names this as a **required App Store/Play Store review mitigation** for a paid-interaction-between-strangers app. Once bodies are encrypted, this is not "harder" — it is **impossible**, by construction, for any message sent after that point.

Two honest paths, not a false binary:

- **(a) Client-side moderation before encryption.** The device runs a moderation check (an on-device classifier, or even still calling OpenAI's API from the client before encrypting) before a message is allowed to send. **The real problem**: this only works if the client is trusted to actually run the check — a modified/jailbroken client can simply skip it and send blocked content anyway. Today, moderation is a server-side gate no client can bypass, on every single message, unconditionally. Under (a), it becomes advisory, enforced only by clients that choose to cooperate. This is a genuine, not cosmetic, regression in the exact mitigation `docs/07` names for app-store approval — worth a real conversation with counsel/whoever owns that review relationship before assuming it's still sufficient, not just an engineering trade-off to absorb quietly.
- **(b) No pre-send content moderation at all**, matching what Signal/WhatsApp itself actually does for E2EE chats — moderation becomes purely reactive (the existing `user_reports`/blocking system, already built), backed by metadata-only fraud signals (rate limits, collusion detection — both already metadata-based, unaffected by encryption, see §6). This is the industry-standard trade-off for real E2EE messaging, and the honest one: claim E2EE, mean it, and rely on reporting instead of scanning.

**This needs your explicit decision, and probably a real conversation with whoever handles app-store/compliance review, before any crypto code gets written** — not because the engineering is hard, but because it changes what `docs/07` §3 can truthfully claim to Apple/Google's review teams.

## 4. The billing-model break — this app charges by content, which is the one thing E2EE hides

**This is the finding that doesn't show up in any generic "add E2EE to your app" guide, because most E2EE messaging apps don't bill per message based on analyzing that message's content. InvolveMe does.**

`docs/03-ECONOMY-LEDGER.md` §4: `credits_charged = 2 × ceil(word_count / 50)`, capped at 500 words — computed **server-side, from the plaintext body**, inside `fn_send_message`'s own atomic transaction (confirmed directly in the live function: `v_word_count := array_length(regexp_split_to_array(trim(...), '\s+'), 1)`). Once the body arrives encrypted, the server cannot count words in it. Two paths:

- **(a) Trust a client-reported word count.** This directly reopens the exact exploit CLAUDE.md rule #1 exists to prevent — "no financial logic on the client... never client-side arithmetic that gets trusted." A modified client reports "3 words" for a 3,000-word message and pays 2 credits for what should cost the maximum. This is not an edge case to accept; it's the app's entire pricing model becoming client-controlled.
- **(b) Bill on ciphertext byte length instead of word count** — the server can measure the size of the encrypted payload it receives without ever decrypting it, so this stays a real, server-verified, client-can't-lie-about-it number. AEAD ciphers (what the Double Ratchet uses) produce ciphertext length that's plaintext length plus a small, fixed per-message overhead — a genuinely workable proxy, and the correct fix.

**But (b) is a real pricing-model change, not an implementation detail** — it needs the same rigor CLAUDE.md rule #9 gives any pricing change: a new formula in `docs/03`, new `pricing_config` keys, and a real look at how the unit economics shift (a message with many short words costs the same as one with few long words under byte-based billing, which isn't true today — whether that's fine or needs its own tuning pass is a product call, not something to silently absorb as a side effect of adding encryption). **Recommend (b)**, but treat the formula change itself as its own reviewed decision, not a rubber stamp.

The same problem recurs in `fn_edit_message` (`edit_would_increase_cost` compares new word count to the original charge, same plaintext-dependent check) and would need the identical fix.

## 5. Fraud-detection regression: duplicate-content detection also goes blind

`docs/06-SECURITY-FRAUD-LOOPHOLES.md` §6's chat-farming defense — confirmed live in `fn_release_escrow` (`similarity(v_message_body, v_recent_body) >= threshold`, using Postgres's `pg_trgm` extension) — compares a payee's message body against their own recent messages, server-side, on plaintext, to catch templated spam farming credit through the escrow-release mechanism. This is a second, independent thing that goes fully dark under E2EE, for the same "server can't read the body" reason as §3/§4.

There's no clean server-side replacement for this one — it's inherently a content-comparison check. Realistic options are the same shape as §3: drop it and rely on the surviving metadata-only fraud signals (message-per-minute rate caps, collusion detection graph, KYC-tiered withdrawal limits — all unaffected, none of them need to read a message body), or accept a weaker on-device version with the same bypassability caveat as client-side moderation. **Recommend accepting the gap** rather than building a fragile client-side replacement — the metadata-based signals were already designed as the primary defense in `docs/06`'s own threat model; content-similarity was a supplementary check, not the only one.

## 6. What stays visible to the server regardless (metadata) — set this expectation correctly up front

Real E2EE protects **content**, not the **social graph**. The server (and RLS-scoped, service-role-authenticated queries) will still always see, in plaintext: who messaged whom, when, how often, message/media byte sizes, thread membership, and delivery/read timestamps — `threads.participant_a/participant_b`, `messages.created_at`, `escrows.credits_held`, all of it. This is exactly what Signal's own security documentation discloses about its own product. Whatever UI copy eventually describes this feature needs to say "your message content" is protected, not imply full communication privacy — the same "don't claim more than what's true" discipline `docs/19` §0 already flagged for the current no-E2EE state applies just as much to an overstated E2EE claim.

## 7. Media encryption

Photos/voice notes need the same treatment Signal uses: generate a random symmetric key per media file, encrypt the file with it client-side before upload, upload the encrypted blob to Storage (which never sees plaintext media either — a real, additional privacy win over today's disk-encryption-only posture), and carry the file's decryption key inside the encrypted message envelope itself (so only the recipient's Double Ratchet session can ever unwrap it). Audio transcription for moderation (`docs/17`'s voice-notes moderation) has the exact same fate as §3's text moderation — impossible server-side once audio is encrypted before upload.

## 8. Admin/support/legal visibility — a real, disclosed capability loss

Today, `service_role` (Supabase Studio, or any internal tooling built on it) can read message content for support disputes, abuse investigation, or a legal request for records. Under real E2EE, **nobody at InvolveMe can do this anymore, ever, for any message sent after the feature ships** — not with more access, not with a different credential, structurally. Worth naming plainly as a real operational and legal-posture change (`docs/07`'s KYC/AML/SAR posture assumes some content visibility exists as a backstop even though it's never been exercised) before treating this as a pure win.

## 9. Existing messages / migration story

Every message sent before this feature ships is, and stays, plaintext in Postgres — there's no retroactive encryption of history. Real design decisions needed: does an existing thread silently start encrypting new messages once both participants' clients support it (mixed plaintext-history + encrypted-going-forward, same as WhatsApp's own historical rollout), or is there a visible "this conversation is now protected" moment? Does a thread with one upgraded and one not-yet-upgraded participant degrade to plaintext for that thread until both are ready, and if so, is that visibly disclosed to the participants or silent? This needs real UX design, not just a backend flag.

## 10. Recommended build order — checkpointed, not one big build

Given the number of sub-decisions above that each carry real product/compliance weight on their own, this should not be scoped as one build — it needs go-ahead at each checkpoint, same discipline every other structural decision in this app's history has gotten (Tier C1's payer role, the credit-transfer compliance flag, multi-currency):

1. **Decide §3 (moderation) and §4 (billing model) first — both need your explicit sign-off, and §3 likely needs input from whoever owns app-store compliance review.** Nothing below is worth designing in detail until these two are settled, since they shape the actual protocol requirements.
2. Pick and vet the crypto library (§1) — a real evaluation pass, not a name asserted today.
3. Design the multi-device-aware key/session model (§2) even if linked-devices UI itself ships later.
4. Schema: public key material tables (identity keys, signed prekeys, one-time prekey pools), `thread_payer_history`-style audit posture isn't needed here (no money moves), but session-state bookkeeping does.
5. `fn_send_message`/`fn_edit_message` changes for byte-length billing (§4), with `docs/03` updated as its own reviewed change.
6. Client: key generation, secure storage (already have `expo-secure-store`), encrypt-before-send/decrypt-on-receive, a real key-verification UI (Signal/WhatsApp's "safety number" contact-verification pattern — genuine UX work, not plumbing).
7. Media encryption (§7).
8. Migration/mixed-history UX (§9).
9. ToS/Privacy Policy rewrite reflecting what's now actually true (a good, honest update at this point — `docs/07` §4/§5's current no-E2EE disclosure becomes obsolete).
10. A real security review before calling this done — a bug here is higher-stakes than almost anything else in this codebase; worth a second pair of eyes (internal review at minimum, external audit if the budget exists) specifically on the crypto/session-handling code before shipping to real users.

## 11. Decisions (resolved 2026-09-26)

- **§3, §4, §2** — all resolved, see the top of this doc. Worth a real conversation with whoever owns app-store/compliance review about §3 before this ships live, even though the technical direction is now settled — that's a business/legal check, not something blocking the engineering from proceeding.
- **Sequencing**: this is the active next thing being scoped in detail (§12 below), following directly from these decisions.
