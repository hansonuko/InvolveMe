-- Found while scoping link-bank-account: docs/03-ECONOMY-LEDGER.md §6
-- requires a withdrawal's bank account to "match the KYC identity," but
-- kyc_records never had anywhere to put the verified name to match
-- against — submit-kyc only stores a one-way hash of the BVN/NIN itself
-- (correctly, per docs/07-COMPLIANCE-LEGAL.md §5 — the hash is
-- deliberately not reversible), which is exactly why it can't double as
-- the name record too.
--
-- A legal name is materially less sensitive than a raw BVN/NIN and is
-- proportionate, necessary retention for the one compliance function this
-- table exists for — this isn't scope creep, it's the missing half of
-- what "match the KYC identity" already requires.
--
-- Nullable: only ever set when a verification actually succeeds
-- (status = 'verified'); a 'failed'/'pending' row has nothing to store.

alter table public.kyc_records add column verified_first_name text;
alter table public.kyc_records add column verified_middle_name text;
alter table public.kyc_records add column verified_last_name text;

comment on column public.kyc_records.verified_first_name is
  'Set only when status = verified — the identity name returned by the KYC provider, used to name-match a bank account at withdrawal-linking time. Never the raw BVN/NIN itself (see bvn_or_nin_hash for that).';
