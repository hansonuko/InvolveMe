# 18 — Chat/Status Refinement Batch: Scoping

**Status (session 34): Tier A and Tier B are built, merged, and shipped — see `docs/00-SESSION-HANDOFF.md` for exactly what and when.** Tier C1 is now fully designed (revised 2026-09-26, see §C1 below) and ready to build on go-ahead; Tier C2 and Tier D remain scoping-only. Read `docs/03-ECONOMY-LEDGER.md` and `docs/06-SECURITY-FRAUD-LOOPHOLES.md` before touching anything in Tier C (CLAUDE.md standing rule) — both are cited throughout below with the exact sections that matter.

Ten items came in as one batch. They sort into four very different risk tiers, not one flat list — bundling a tick-color tweak with a proposal to let money flow in a direction this app's core economic model explicitly forbids would be a mistake in itself. Build order at the bottom follows the tiers.

## Tier A — safe, low-risk, buildable now (no further scoping needed)

### A1. Read-tick size + color

**Current state** (`app/thread/[id].tsx:607-613`): `Ionicons name={isRead ? 'checkmark-done' : 'checkmark'} size={14} color={withAlpha(colors.textInverse, isRead ? 1 : 0.75)}`. Read state today is just full-opacity vs. 75%-opacity of the same bubble-text color — no color change at all.
**What's asked:** bigger/bolder, WhatsApp-sized, and the double-tick turns **yellow** on read.
**Two real notes, not blockers:**

- I can't pixel-measure the live WhatsApp app from this environment, so "exact size" is an honest approximation, not a verified match — recommend 16 (up from 14, a real step up, sized close to this app's own body-text line height, the same proportion WhatsApp's own tick-to-text ratio uses). Worth a side-by-side glance once shipped; trivial to nudge.
- **WhatsApp's real read-tick color is blue, not yellow** — this ask is a deliberate InvolveMe-specific deviation, not an error on my part in "matching WhatsApp." Flagging so it's a conscious choice, not an accidental mismatch someone questions later.
- Per `docs/04-DESIGN-SYSTEM.md`'s own rule (never hardcode a hex inline), this needs a real token, not a literal color in the component. `theme/tokens.ts` already has `accentCredit` (gold/amber, `#F5A623` light / `#FFC24D` dark) and `warning` (also amber-ish) — reusing either would double up their existing semantic meaning (credit-accent / warning-state) with "message read," which reads confusingly later. **Recommend a new dedicated token**, e.g. `tickRead`, added to both light/dark palettes in `tokens.ts` the same way every other token there is documented (one-line rationale comment, per that file's own convention).

### A2. Status-viewers list — half-screen sheet, not full screen

**Current state** (`components/status/StatusViewersModal.tsx:36`): `<Modal visible={visible} animationType="slide" onRequestClose={onClose}>` — no `presentationStyle`, which on a plain `Modal` renders full-screen. `FlatList` is already inside it (scrolling already works).
**Fix:** wrap the content in a fixed-height (e.g. ~50-60% of screen) bottom sheet inside the existing `Modal` (`transparent` + a bottom-anchored `View` with a max height, backdrop tap to dismiss) rather than letting the `Modal` fill the screen — same shape WhatsApp's own status-viewers sheet uses. The `FlatList` underneath needs no changes; it already scrolls within whatever container height it's given.

### A3. Buy Credit entry points in chat

Confirmed a `BuyCreditModal` already exists and is already wired into `thread/[id].tsx` (triggered today only from the insufficient-credit flow). Add two more trigger points to the **same existing modal** — no new component:

- A menu item in the 3-dot overflow (`MenuModal`-equivalent around `thread/[id].tsx:225-320`, alongside Mute/Block/Report).
- An icon in the chat header itself, between the back arrow/avatar block and the 3-dot menu.

### A4. Merge "+" new-chat into one real search (name + not-on-device phone)

**Current state:** two disconnected experiences. `ChatsSubHeader`'s "Contacts" sub-tab (`ContactsList`, `chats.tsx:713-889`) already does exactly the search UX being asked for — search-as-you-type by device-contact name, sectioned "On InvolveMe" / "Invite", tap-to-start-thread — but only over contacts actually saved on the device. `NewChatModal` (`chats.tsx:239+`) is the literal "+" button's target today: raw E.164 phone entry, an explicit "Look up" tap, exact match only, no search-as-you-type, no name matching at all.
**Fix:** replace `NewChatModal`'s screen with `ContactsList`'s search UX (reused, not reimplemented), **plus** fall through to the existing exact-match phone lookup (`useFindUserByPhone`, already used by `NewChatModal` today) once the typed query is a complete, valid phone number — surfaced inline in the same result list rather than a separate "Look up" button/step. This covers both halves of the ask (name-as-saved-on-device, and a number not saved on-device at all) using only pieces that already exist.
**One real thing to get right, not a blocker:** don't turn this into a general partial/prefix phone-number search against the backend. Today the only way to find someone by phone is one exact E.164 match — a real, if informal, anti-enumeration property (nobody can fish for which numbers are registered by typing digit-by-digit and watching results appear). Keep the phone half of this exact-match-only, same as today, just triggered automatically instead of via a button tap — search-as-you-type should stay scoped to the name dimension (which is already safe, since it only ever searches your own device's contact names).

### A5. Disable Calls, move Groups to its own bottom tab

**Current state:** bottom tabs are Chats / Calls / Wallet / Status (`app/(tabs)/_layout.tsx`); `calls.tsx` is already a deliberate stub (`docs/08-BUILD-PHASES-ROADMAP.md`'s own "explicitly deferred, no monetization model designed yet" note — this ask doesn't change that reasoning, just formalizes it in the nav). "Group" isn't a header button — it's the middle segment of the Chats screen's own Chats/Groups/Contacts row (`ChatsSubHeader`), backed by `GroupsList`.
**Fix:** remove the `calls` tab from `Tabs.Screen` registration (keep `calls.tsx` and its route untouched on disk — trivial to re-add later, matching "leave it for future build" literally). Add a new `groups.tsx` tab screen in that vacated slot, lifting `GroupsList` + its own "+" (`NewGroupModal`) out of the Chats segmented row into this new top-level tab. Chats' own segmented row drops to just Chats/Contacts. `Contacts` isn't mentioned in the ask, so it stays where it is — not silently relocated too.

### A6. Remove the standalone emoji picker

**Current state:** `components/chat/EmojiPicker.tsx` + `lib/emojiData.ts`, wired into both `thread/[id].tsx` and `group-thread/[id].tsx` identically (a toggle button that swaps the composer's mic/happy icon, `showEmojiPicker` state, the picker panel itself rendered below the composer).
**Fix:** remove the toggle button, the `showEmojiPicker` state, the `EmojiPicker` import/render, and the component + its data file, from **both** thread screens symmetrically — this was already built twice, not once, so removing it in only one place would be a real, easy-to-miss half-fix. Device keyboards already have a native emoji picker, so this is a pure deletion, no replacement needed.

## Tier B — real billing decision, but tractable in one build

### B1. Free status replies

**Current state, confirmed in code, not assumed:** replying to a status is **not** a distinct feature today — `StoryViewer.tsx:332` calls the exact same `useSendMessage` mutation as ordinary chat, with a real `thread_id` and `body`. It is billed at the normal word-count rate, escrowed, and (once the recipient replies back) released as normal earnings — indistinguishable from any other message once sent. There is no "this was a status reply" marker anywhere in the schema today.

**Why this needs a real design, not just "set price to 0":**

- Making it free means `credits_charged = 0` for that one send — which per `docs/03` §5's own model means there is nothing to escrow and nothing for the poster to ever earn from that specific message (no payment happened, so there's nothing to release later). That's a real, product-visible behavior change worth being explicit about: a free status reply is closer to a "like" than a message, earnings-wise. If the intent was "free to send, but the poster still earns once they reply back" — that's a different, bigger change (it would mean creating an escrow with nothing actually collected from the sender, which breaks the ledger-conservation invariant CLAUDE.md rule #4 requires — a ledger entry needs a real debit behind it). Recommend the simpler, conservation-safe reading: free means no charge and no escrow, same "no message, no charge" posture a `word_count = 0`-but-with-media message already gets, just applied to zero-cost text.
- **The real loophole to close:** this can't be "any message sent from the status-reply composer is free," or it becomes a general free-messaging backdoor — reply to your own throwaway status (or a colluding account's) and send unlimited zero-cost content into what's otherwise a normal, indistinguishable thread. The free exemption must be scoped tightly and enforced **server-side inside `fn_send_message`**, never trusted from a client-supplied flag: free only applies to the one message that (a) is the sender's first message ever in that thread, **and** (b) is sent with a real `reply_to_status_id` referencing a status that actually exists, hasn't expired, and is visible to the sender under the existing status-visibility RLS (`status_updates_select_visible_to_thread_partner`). Every message after that first one — including a second reply to a different status from the same poster — is a normal, billed message, exactly like today.
- **Spam angle, not a money angle:** since nothing is charged, this removes the one natural deterrent every other message has against being used to spam a stranger. Existing velocity/rate-limit infrastructure (`docs/06` §6) should apply to free status replies too — don't let "free" also mean "unlimited," even though there's no direct credit-to-cash exploit here (a $0 charge can't be laundered).
- Schema implication: a genuinely free, un-escrowed message needs a `status = 'sent'`-equivalent path that skips escrow creation entirely, not a `credits_charged = 0` row artificially forced through the existing `escrowed` flow (a zero-value escrow row is dead weight and a confusing edge case for the expiry-sweep/release code to special-case forever).

This is real but bounded — one migration (a `reply_to_status_id` column + the `fn_send_message` branch above), one Edge Function change, no new UI beyond what `StoryViewer` already has. Buildable in the same session as Tier A once you confirm the "free = no escrow, poster earns nothing from it" reading is the one you want.

## Tier C — needs its own dedicated scoping/build-authorization pass before any code (same weight as `docs/11`'s calls doc)

### C1. Payer/Earner toggle ("Charge from me") — REVISED DESIGN (2026-09-26, session 34)

**Status: designed, not built.** The first pass at this section (kept below as §C1-superseded, for the record of why the simpler design won) treated the literal brief — a per-message "pending consent, decide on reply" mechanic — at face value, and correctly found it genuinely risky: it breaks the atomic-debit invariant every other message in this app relies on, needs a new message lifecycle state, and has an unresolved "what if their balance changed by the time they replied" failure mode. Going deeper surfaced a materially simpler design that delivers the same real outcome without any of that risk, by re-modeling the actual problem as a **role**, not a **per-message decision**.

**The real problem, restated precisely (not the mechanism the brief sketched):** whoever is structurally `participant_a` (fixed forever at thread creation) gets auto-debited for every message anyone sends in that thread, including one the other person decided to send unprompted, with no way to hand that role off — even when the other person would rather pay this time, or the original payer wants to stop. The brief's own stated goal — _"this way, duplicating chats for the same user will be avoided"_ — doesn't actually match reality (threads are already unique per pair; there's no duplicate-thread bug to fix), so that framing is set aside; the design below fully solves the real gap instead.

**The mechanism:**

- **One new column, `threads.payer_id`** (nullable, defaults to `participant_a` at creation — every thread that predates this feature, and every thread whose participants never touch it, behaves exactly as today, zero migration risk). `payer_id` is resolved **before** a message is ever created — `fn_send_message` debits whoever it names instead of hardcoding `participant_a`. Same atomic transaction, same escrow mechanic, same `fn_release_escrow` flow, same everything downstream — one dynamic wallet lookup instead of a fixed assumption. **No new message status, no pending state, no deferred billing.**
- **"Charge from me"** does exactly one thing: sets `payer_id` to the caller's own id. Enforced server-side that a caller can only ever appoint _themselves_, never the other participant — nobody can be made to pay against their will. Either participant can do this at any time.
- **Stepping down**: the current payer can set `payer_id` back to `null`. While null, a send from **either** side is rejected outright (a real, specific error — e.g. `no_active_payer` — not `insufficient_credit`, not a silent free send) until one of the two participants claims the role again. This is what actually answers _"the user may not be willing to pay... at the time"_ — cleanly, and without the ambiguity the original "reply = consent" mechanic had (what does a reply that only says "stop messaging me" count as? This design has no such trap: nothing is ever charged unless someone is _currently and explicitly_ holding the payer role).
- **Nothing is ever retroactive.** `payer_id`/`payee_id` are resolved and frozen into each message's own escrow row at send time, exactly as today — a later reassignment on the thread never touches history. Editing (`fn_edit_message`) and deletion (`fn_delete_message_for_everyone`) need zero changes; they already operate on rows with fixed payer/payee.
- **Explicitly out of scope**: group chat (`group_threads`/`group_messages`) — separate, still-kill-switched billing model, unrelated to this.

**UI — reuses an existing surface, not a new screen.** `thread/[id].tsx` already renders a static banner (_"They pay for this conversation — your replies earn, they do not cost you"_) gated on `!headerInfo.isPayer`. Made live and tappable, driven by `payer_id` instead of the fixed `participant_a`/`participant_b` roles:

- Not currently paying: **"They're paying · tap to pay instead"**
- Currently paying: **"You're paying · tap to stop"**
- `payer_id is null`: **"No one's paying right now · tap to pay"**

**Fraud angle, addressed directly, not deferred:** a reassignable payer role is a real amplification of the collusion pattern `docs/06` already documents for group chat and `docs/11` §4 flags again for calls (two accounts you control, alternating who "earns," converting `topup_credit` into cash with no real value exchanged) — today's fixed-for-life payment direction is itself the friction limiting that pattern per thread; removing it uncaps it. Two concrete, cheap mitigations, both matching patterns already live elsewhere in this codebase, not a new paradigm:

1. **A cooldown on reassignment** — a new `pricing_config` key (e.g. `thread_payer_reassignment_cooldown_minutes`, a few hours is plenty) bounding how fast a colluding pair can round-trip credit between the two roles, without touching the legitimate "occasionally decide who's paying" case at all.
2. **A new collusion-detection signal** — rapid payer-flip-then-immediate-reply pairs, feeding into the existing `fn_run_collusion_detection`/fraud-signals pipeline (`docs/06` §2), not a new parallel system. Confirm it actually fires on this pattern before shipping, same "don't assume it generalizes for free" caution `docs/11` §4 already states for calls.

Worth stating plainly: this doesn't reopen anything the withdrawal gate already closes. Actually converting to real cash still requires KYC Tier ≥1 and a verified, name-matched bank account (`docs/03` §6), regardless of how fast credit moves internally between two accounts — so the residual exposure here is _internal velocity_, not a new path to real money. That's exactly what the cooldown targets, sized accordingly rather than as a blanket restriction.

**Auditability — one small addition, matching this codebase's existing standard for anything money-adjacent:** a `thread_payer_history` table (`thread_id, changed_by, new_payer_id, changed_at`), append-only, same posture `pricing_config_history`/`admin_audit_log` already establish. Not load-bearing for the mechanism itself — cheap, and the right level of rigor for a feature that changes who pays.

**Net build size:** one new column, one new `SECURITY DEFINER` function (`fn_set_thread_payer` — self-only target, cooldown-gated, participant-only), one small audit table, one new `pricing_config` key, a `fn_send_message` change to resolve the payer dynamically instead of assuming `participant_a`, and a UI change that's really just making an already-existing banner interactive. No new message lifecycle, no new race condition, no new escrow shape.

**Recommendation:** this is the version to build, once you give the go-ahead — materially smaller and safer than the original brief's literal mechanic, while fully answering the real need behind it.

<details>
<summary>§C1-superseded — original scoping pass (2026-09-25), kept for why the revised design above was chosen over it</summary>

This is the biggest item in the batch, and it proposes changing something `docs/03` §2 states as a fixed rule, not an implementation detail: _"Every message in a paid thread — from either side — costs credits, debited from **A's** `topup_credit` (A is always the paying party in a given thread; B never pays to participate in a thread A initiated)."_ The toggle asks for exactly the case that sentence rules out: letting B become the payer for a specific exchange, and letting A opt out of being charged for a specific incoming message. That's not a bug fix on top of the current model — it's a different model, and it needs to be designed with the same rigor `docs/11` gave calls' billing shape, not shipped as a UI checkbox on top of `fn_send_message` as it stands today.

**What building this correctly would require, taken literally:**

1. **A new "pending consent" message state, not just a toggle.** The ask is explicit: _"before it lands the other user an earning, it should give this currently paying user the opportunity to avoid deduction... if they reply... that would mean consent."_ That means a message from B can no longer debit A atomically at send time the way `fn_send_message` does for every message today (CLAUDE.md rule #3: one atomic transaction, never "debit now, credit later in a separate call" — this is the mirror problem, "debit _later_, after the fact," and needs the same rigor). Two ways to do it, and the choice matters:
   - **(a) Reserve, don't commit, at send time.** Check A's balance and place a hold (same shape an escrow already is) the moment B sends, but don't release it as B's earning until A either replies (implicit consent) or the hold expires/gets explicitly declined. This preserves "the money's presence is guaranteed if consent happens," at the cost of A's balance being encumbered before they've agreed to anything.
   - **(b) Don't touch A's balance at all until consent.** The message delivers, uncharged, in a real "awaiting consent" status. Only on A's reply does the actual debit run — but now it has to handle a failure mode this app has never had: A's balance may no longer cover it by the time they reply, for a message that's already been delivered and read.
2. **`escrows.payer_id`/`payee_id` can no longer be assumed `thread.participant_a`/`participant_b`** — a real schema and query-pattern change touching every place currently assuming "A pays, B earns" is a thread-level constant.
3. **The collusion angle** — a bidirectional payer/earner toggle is a more convenient version of the exploit `docs/06` already documents for group chat and `docs/11` §4 flags for calls.

This version is what made the feature look genuinely risky. The revised design above solves the identical real-world need by resolving "who pays" as a standing role before a message is ever created, rather than as a per-message consent race — which is what removes the new-message-state/balance-race problem entirely, not a smaller version of the same risk.

</details>

### C2. Boosted/"Suggested" status (paid reach)

**Baseline, confirmed in the RLS policy, not assumed:** a status is visible today **only** to people the poster already has a real thread with (`status_updates_select_visible_to_thread_partner`) — not "contacts," not "everyone," people you've actually messaged. This is narrower than the ask realizes: _"reach more InvolveMe audience"_ / _"go wider and viral across InvolveMe users"_ means showing a poster's status to people they have **never interacted with at all**. That's not a pricing tier on the existing feature — it's a new content-discovery surface this app has never had, and it changes the moderation/compliance stakes materially: content reaching strangers algorithmically ("viral") is a different risk class than content only reaching people you already have a relationship with, the same kind of jump `docs/11` §6 flags when real-time media crosses from "this app's known data-protection posture" into new territory.

**Real, unanswered questions this needs before a build, not during one:**

- **Who are the 500?** Random InvolveMe users, or some affinity/region-based selection? This is a real algorithm decision (and a fairness one — "random strangers see my content because I paid" needs its own reasoning about who gets exposed to what), not a detail to improvise while writing the query.
- **Moderation has to run _before_ a boosted status goes live, not fail-open after**, unlike this app's existing text/image/audio moderation which currently fails open on a provider outage. A boosted status reaching 500 people it wouldn't otherwise reach makes a moderation gap materially worse than the same gap on a status only your existing threads see — worth a stricter posture specifically for this path (block-until-checked rather than allow-then-log) even if the rest of the app stays fail-open.
- **New revenue line, not covered by `docs/03` §8's existing table.** "8 credits per 500 users reached" needs its own `pricing_config` key(s) and its own row in that revenue table — _"all paid statuses come as revenue to InvolveMe"_ means this is a platform fee straight to the platform wallet, not an earnings-split like message escrow, closer in shape to the top-up fee than the message-escrow flow.
- **A genuinely new compliance question**: this is InvolveMe's first algorithmic content-promotion/ads-adjacent feature. `docs/07-COMPLIANCE-LEGAL.md` was written against consented, relationship-based messaging — worth a real look at whether promoted/sponsored-content norms (disclosure, app-store review policy on paid content amplification) apply here, the same "add this to the pre-launch checklist, don't assume it's covered" instruction `docs/11` §6 and `docs/03` §10 both already give themselves for their own new-ground features.

**Recommendation:** same posture as C1 — scope this properly (audience-selection algorithm, pre-publish moderation gate, the new pricing_config/revenue-table entries, a real compliance look) as its own pass before building, not as a checkbox on the existing status-upload flow.

## Tier D — flagged as a mistake in the request itself, don't build as literally asked

### D1. "End-to-end encryption," as described

This is the one item in the batch that isn't a scoping-complexity problem — it's a **factual accuracy problem**, and it's the most important thing this review caught. Real end-to-end encryption means not even InvolveMe's own servers can read message content. That is **directly incompatible with a feature this app already ships and that this very session extended**: `send-message`'s content moderation (`moderateText`/`moderateImage`/`moderateAudio`) downloads and reads the actual plaintext/raw bytes of every message server-side to run it through OpenAI's moderation API. A server that can decrypt a message to moderate it is not end-to-end encrypted, by definition — the two are mutually exclusive as this app is built today, not a detail to work around later.

Telling users _"your messages are safely encrypted"_ in E2EE terms while that isn't true would be a **real, false claim** — the kind of thing that becomes a legitimate trust/legal problem (misrepresentation, not just a bug) the first time anyone checks, not a cosmetic detail. This is exactly the "hold behind a flag, flag for legal review rather than ship live" instruction CLAUDE.md's compliance section already gives for anything in this territory.

**Two honest paths forward, not a false binary:**

1. **Say what's actually true.** Messages are encrypted in transit (TLS) and at rest (Postgres/Storage encryption-at-rest, standard on Supabase), and access is gated by RLS so only the two thread participants and the service role can ever read a message. That's real, standard, and worth telling users — with accurate language ("your messages are protected" / "secured," never "end-to-end encrypted," which is a specific, well-understood technical claim WhatsApp's own users would recognize as false if it turns out any server-side process reads the content, which content moderation genuinely does here).
2. **If real E2EE is actually wanted**, that's a legitimate, large feature — but it means redesigning content moderation entirely (client-side moderation before encryption, or accepting zero server-side moderation, a real product/safety trade-off), building real per-device key management (which has no foundation yet — `docs/12-LINKED-DEVICES-WEB-SCOPING.md`, multi-device support, isn't built), and is its own multi-week project on the scale of `docs/11`'s calls doc, not a chat-header banner. Flag it as a real want, scope it separately, with a from-day-one answer to "what happens to moderation" before writing a line of crypto code.

**Recommendation: (1).** Ship accurate security-posture copy now (cheap, true, still reassuring), and treat real E2EE as its own future scoping pass only if there's a genuine appetite for the moderation trade-off it forces.

## Build order

1. **Tier A, all six pieces** — ✅ built, merged, shipped (session 33/34). See `docs/00-SESSION-HANDOFF.md`.
2. **Tier B (free status replies)** — ✅ built, merged, shipped (session 34). See `docs/00-SESSION-HANDOFF.md`.
3. **Tier C1 (payer/earner role)** — designed (§C1 above, session 34), not built. Ready to build on explicit go-ahead — no further scoping needed.
4. **Tier C2 (boosted status)** — still needs its own dedicated design pass (audience-selection algorithm, pre-publish moderation gate, new pricing_config/revenue-table entries, a real compliance look) before a build.
5. **Tier D** — a copy/wording fix (option 1 in that section), still not built; real E2EE only if wanted as its own scoped project after seeing the trade-offs above.

Tiers A and B are live. C1 is designed and awaiting a build go-ahead; C2 and D are still open.
