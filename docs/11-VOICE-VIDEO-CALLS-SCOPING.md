# 11 — Voice/Video Calls: Scoping (not built)

**Status: scoping only, 2026-09-18. Nothing in this document is built.** `app/(tabs)/calls.tsx` remains the "Not available yet" stub it has been since Phase 0. This doc exists so that when this feature is actually scheduled, it starts from a real design pass instead of getting bolted on — the same discipline `docs/03-ECONOMY-LEDGER.md` §10 applied to group chat, and the same reason `docs/08-BUILD-PHASES-ROADMAP.md`'s deferred-list entry for this feature explicitly says "decide whether calls are also pay-per-minute before building, don't bolt it on later without re-running the economics."

**Product decision, made 2026-09-18 (this document's originating conversation):** calls are **pay-per-minute**, matching this app's whole pay-per-message identity rather than becoming the one free feature in an otherwise entirely paid product. Everything below is scoped against that decision — a "make it free instead" pivot later is possible, but would remove most of §1's complexity and most of §4's fraud surface, so it's cheaper to decide now than to build the metered-billing machinery and then rip it out.

This is a **multi-week, cross-cutting feature** — a new real-time media dependency, a new billing model with different failure modes than anything else in this app, new native-platform work (CallKit/ConnectionService) for a call to work the way users expect it to, and a second look at this app's compliance posture. It should be built as its own project with its own milestones, not squeezed into a punch-list session alongside UI fixes.

## 1. Economics — why this can't reuse §4/§5's message-billing shape

Message billing works because a message is a single, instantaneous, already-fully-known-cost event: compute `credits_charged` once, debit once, done. A call is none of those things — it's an open-ended duration nobody knows in advance, which breaks the "compute cost, then charge" pattern at its root.

**The core design question: pre-authorization + running debit, not compute-then-charge.**

```
call_connect_fee_credits     = flat per-call connection cost (config), analogous to
                                message_base_credits — charged once, on answer, not on ring
call_per_minute_credits      = per-minute rate (config), likely different for voice vs. video
                                (video costs the provider more — see §2)
```

- On answer (not on dial — a call nobody picks up shouldn't cost anything, same "B never had a claim on credit they didn't respond to" principle §5 already establishes for unanswered messages), debit `call_connect_fee_credits` and start a running per-minute meter.
- The meter needs a **live low-balance cutoff**, not a post-hoc bill — unlike a message, a call can't be "rejected for insufficient credit" after the fact once the parties are already mid-conversation. This means either: (a) a background job ticking every N seconds during an active call, debiting and hanging up on insufficient credit, or (b) a client-side warning + grace period backed by a server-side reconciliation that force-ends the call and settles for actual elapsed time if the client's own end-signal never arrives (calls can end by app crash, connection loss, force-quit — none of which guarantee a clean "call ended" signal reaches the server). **(b) is very likely the right shape** — a server that can't trust the client to say "I hung up" needs its own authoritative timeout regardless, and reusing that same mechanism for "ran out of credit" avoids building two parallel truncation paths.
- **Billing granularity**: per-minute vs. per-second matters a lot more here than message word-blocks did, because rounding a 90-second call up to 2 minutes is a much bigger relative overcharge than rounding a slightly-long message up to the next word block. Recommend per-second accrual with a per-minute _rate_ (i.e. `credits = ceil(seconds_elapsed / 60 * per_minute_rate)` — billed in fractional-minute credit amounts, not truncated to whole minutes), same "don't let rounding be a silent revenue leak or a silent overcharge" principle §3's `leftover_kobo` handling already establishes.
- **Who earns**: same A-pays/B-earns split as 1:1 messaging (§2), with the same 20% `platform_earning_take_bps` cut on B's side — no reason to invent a second take-rate unless a real cost-modeling pass (§2 below) says otherwise. Unlike escrow, this settles as it accrues (or in short periodic batches), not on "B replies," since there's no equivalent trigger — the whole call _is_ the two-way exchange.
- **A call that never connects** (no answer, declined, one side's device fails to establish media) charges nothing — same principle as an unanswered message's escrow refund.
- **A call that drops mid-stream** (network loss, app killed) settles for actual elapsed time up to the last point the server can attest to (last successful meter tick), not the full intended duration and not zero — refunding an entire connected call because the last few seconds didn't get billed would be a bigger and easier exploit than the rounding question above (repeatedly "network drop" a call right after connecting).

**Real, unresolved cost-modeling question, same shape as §3's top-up-fee finding:** a calling provider (§2) charges InvolveMe **per participant-minute**, on top of whatever InvolveMe charges the user. If `call_per_minute_credits`'s cash value doesn't clear the provider's own per-minute cost with margin left over, this loses money on every call the same way the 2% top-up fee was found to potentially lose money on every top-up (§3) — model this with the actual provider's real pricing (§2) before setting `call_per_minute_credits`'s default, not after.

## 2. Calling infrastructure — provider evaluation, not yet chosen

Real-time audio/video needs a signaling layer (who's calling whom, session negotiation) plus a media layer (the actual audio/video transport — raw peer-to-peer WebRTC struggles at scale with NAT traversal and needs TURN relay infrastructure neither Supabase nor this app currently operates). Candidates, roughly in "less own-infra" to "more own-infra" order:

| Option                                                                                                                                                         | What it gives you                                                                        | What it costs                                                                                                                                                                                                                                            | Fit                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Managed WebRTC platform** (e.g. a provider offering an SDK + per-minute billing, category examples: Agora, Twilio Video, Daily, Stream Video, LiveKit Cloud) | SDK handles signaling + TURN + media relay; React Native SDKs exist for all of the above | Real, metered, provider-specific per-minute pricing — this is the number §1's cost-modeling question needs                                                                                                                                               | Fastest to ship, least "stay lite" (a real new SDK dependency, likely the single largest native dependency this app has added)                                           |
| **Self-hosted LiveKit/Janus/mediasoup**                                                                                                                        | No per-minute provider fee                                                               | Real infrastructure to run, patch, and scale (a media server is a genuinely different operational category from this app's current all-Supabase footprint) — a bad fit for a team currently running zero own infrastructure                              | Only worth it at a scale where provider per-minute fees would clearly cost more than running servers                                                                     |
| **Raw WebRTC, peer-to-peer, Supabase Realtime as the signaling channel**                                                                                       | Zero new infra for signaling (Realtime already exists here)                              | No TURN relay of your own means calls between two users on restrictive NATs (common on mobile carrier networks) will frequently fail to connect at all — this is the option most likely to produce "calls just don't work sometimes" as a support burden | Cheapest to prototype, weakest reliability; realistically needs a TURN service (many managed WebRTC platforms include one, which pulls back toward the first row anyway) |

**Recommendation for the eventual build, not a decision made now:** start with a managed provider for the MVP (first row) — this app has zero real-time-media operational experience, and "does the call reliably connect across real mobile networks" is a solved problem in that tier and a genuinely hard one to solve from scratch. Revisit self-hosting only if provider per-minute costs become a real margin problem at scale, the same "not now, revisit if it becomes real" posture `docs/06-SECURITY-FRAUD-LOOPHOLES.md` already uses for a couple of its own deferred items.

**Signaling for an incoming call while the app is backgrounded/killed** needs a real push notification (Expo push, already wired up per `lib/push.ts`) that triggers native call UI — see §5.

## 3. Data model sketch (not built — shape only, for the eventual migration)

New tables, parallel to `group_threads`/`group_messages` rather than extending `threads`/`messages` (same "don't fork the tested 1:1 money path with `if is_call` branches" reasoning `docs/02-DATA-MODEL.md`'s group-threads note already gives):

- `calls`: `id, thread_id, caller_id, callee_id, kind ('voice'|'video'), status ('ringing'|'connected'|'ended'|'missed'|'declined'|'failed'), started_at, connected_at, ended_at, billed_seconds, credits_charged, payer_earning_credits, platform_take_credits`.
- A periodic-billing mechanism needs its own audit trail distinct from a single ledger entry per call — likely `call_billing_ticks (call_id, tick_at, seconds_billed, credits_charged)` so a disputed call has a real accrual history, not just a final total. Exact shape is a real design question for whoever picks this up, not settled here.
- `pricing_config` keys: `call_connect_fee_credits`, `call_voice_per_minute_credits`, `call_video_per_minute_credits` (video plausibly priced higher — costs the provider more, per §1/§2), `call_platform_take_bps` (independently tunable from `platform_earning_take_bps`, same "each take-rate gets its own key" rule CLAUDE.md rule #9 and every existing take-rate in this codebase already follow), `call_low_balance_grace_seconds` (how long a call survives after the payer's balance can no longer cover the next tick, before a forced hang-up).

## 4. Fraud/abuse surface — likely worse than group chat's, not better

§10's group-chat exploit (colluding accounts converting `topup_credit` into cash with no reply-gate) has a direct, arguably easier analog here: two colluding accounts call each other and leave the call connected, silent, for hours. Unlike a scripted message flood, this needs **no scripting at all** — just two phones left face-down — and produces a steady, automatic credit-to-cash conversion for as long as the call stays up. This is not a hypothetical to defer past Phase 5 the way group chat was; if calls ship pay-per-minute, this needs its own answer before launch, not after:

- A **maximum single-call duration** (config, not hardcoded) is close to mandatory, not optional the way it was debatable for group chat.
- The existing collusion-detection infra (`fn_run_collusion_detection`, `docs/06-SECURITY-FRAUD-LOOPHOLES.md` §2) was built against message/thread patterns — confirm it actually fires on a call-heavy account pair, don't assume it generalizes for free.
- Velocity limits (§6's existing infra) likely need a calls-specific variant — "N minutes of calls per day" is a different shape than "N messages per day."
- KYC-tier gating on _earning_ from calls (not just withdrawing) is worth considering given how passive the exploit is — a real product/risk decision for whoever scopes the actual build, flagged here rather than answered.

## 5. Mobile — what "active" call buttons actually require

The punch-list ask was "add the Video and Audio call buttons to the header... that should be active too." Concretely, "active" means all of the following, not just a button that does something:

- **Permissions**: microphone (voice + video) and camera (video) — new `expo-camera`/provider-SDK-specific permission prompts, each needing the same `withAppLockSuppressed` bracket this session's app-lock fix established for every other system dialog (see `lib/appLock.ts`'s header comment) — a call built without that bracket would immediately reproduce the exact false-positive-relock bug this session just closed.
- **Ringing UI** for the callee, including **while the app is backgrounded or killed** — this is what CallKit (iOS) / ConnectionService (Android) exist for: OS-level native call UI that can wake and ring even when the app process isn't running, the same way a real phone call or a WhatsApp call does. Skipping this and only ringing while the app happens to be foregrounded would feel broken compared to every reference app this feature is being built to match.
- **In-call UI**: mute, speaker/earpiece toggle, camera flip + on/off (video), end-call, an elapsed-time/cost indicator (this app's whole identity is pay-per-X — hiding the running cost during a metered call would be a bad-faith UX choice, not just an omission).
- **Low-balance handling**: a warning before the grace-period cutoff (§3's `call_low_balance_grace_seconds`), not just a call that silently drops.
- **Call history**: the `calls.tsx` tab stops being a stub and becomes a real log (missed/answered/duration/cost), reusing the transaction-history patterns `TransactionHistory`/`useLedgerEntries` already established for wallet activity.

None of this is buildable as a quick addition to the existing header — it's the reason this whole feature needs its own milestone plan rather than a spot in a bug-fix session.

## 6. Compliance — a second look needed, not assumed clear

`docs/07-COMPLIANCE-LEGAL.md`'s money-transmission framing was written against message-based credit flow; pay-per-minute calling is the same underlying wallet mechanism (no new transmission concept) but real-time audio/video adds surface that document doesn't currently cover at all:

- **Call-recording consent law** varies by jurisdiction (many require **all**-party consent, not just one-party) — only relevant if this app ever records or stores call audio/video. If it never does (recommended default — "stay lite," and recording adds a whole storage/retention/subpoena-exposure problem this app doesn't need), this becomes a one-line "we don't record calls" statement rather than a real compliance project. Decide "never record" explicitly, in writing, before building rather than defaulting into it by omission.
- Real-time media makes this app's data-protection posture (what crosses the wire, through which provider, in which jurisdiction — relevant once §2's provider is actually chosen) worth a fresh look, same "add this section to the pre-launch checklist when the feature is actually scheduled" instruction §10 gives itself for group chat's own compliance angle.

## 7. Suggested MVP scope, if/when this is picked up

Not a commitment, a starting recommendation for whoever scopes the real build:

- **Voice only first, video second** — video roughly doubles the provider-cost and UI surface (§1, §5) for a feature that's unproven at any volume yet; voice alone already exercises every hard part (metered billing, ringing/CallKit, fraud gating).
- **1:1 only, no group calls** — a group call's billing model (who pays, does everyone pay, does only the initiator pay) is its own unanswered design question layered on top of an already-new metered-billing model; don't stack two unresolved designs in one build.
- **A provider trial/cost model pass (§1's unresolved question, §2's table) happens before any code**, same "plan the doc, then build to it" convention this session's group-chat work followed for its own migration.

## Non-goals for any v1 of this feature (explicit, not just unlisted)

Call recording/transcription, group calls, screen sharing, call-quality analytics/telemetry beyond what the chosen provider gives for free, any free tier or promotional free-minutes mechanic (a referral/promo-adjacent decision `docs/06` §10 already flags as needing its own prerequisites this app doesn't have yet).
