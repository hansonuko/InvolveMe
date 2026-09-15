-- App-store submission blocker: age gate (docs/07-COMPLIANCE-LEGAL.md §4,
-- docs/00-SESSION-HANDOFF.md session 13, continued). Neither this app nor
-- Prembly's actual BVN/NIN verification response includes a date of
-- birth (confirmed this session by reading the live-confirmed response
-- types in packages/kyc/prembly.ts) — self-attestation at signup,
-- combined with Terms/Privacy acceptance in the same checkbox, is the
-- only workable check and is the standard pattern virtually every
-- messaging app uses for this.
--
-- One timestamp, not a separate boolean + a separate DOB field: the
-- signup checkbox is a single combined statement ("I'm 18+ and I agree
-- to the Terms/Privacy"), so one nullable timestamp (null = not yet
-- accepted) is the complete, honest record of it — matches this
-- project's own "one source of truth, not two that could disagree"
-- precedent (push_tokens' header comment makes the same call for a
-- different flag).

alter table public.users add column terms_accepted_at timestamptz;

-- Self-scoped, low-stakes: same posture as read_receipts_enabled's own
-- grant just above it in this table's history — a user has no fraud
-- incentive to misrepresent their own consent timestamp, so this doesn't
-- need the SECURITY DEFINER treatment kyc_tier/is_suspended/
-- device_fingerprint_ids get.
grant update (terms_accepted_at) on public.users to authenticated;
