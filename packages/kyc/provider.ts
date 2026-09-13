/**
 * KycProvider interface — mirrors packages/payments/provider.ts's pattern
 * (CLAUDE.md rule #5's spirit, applied here even though that rule is
 * written about payment providers specifically): every KYC vendor call
 * goes through this, never a vendor SDK directly from a feature module.
 * `kyc_records.provider` already anticipates more than one vendor
 * (docs/02-DATA-MODEL.md), so this is the same shape of abstraction that
 * table's own schema was designed around, even though only one
 * implementation (Prembly) exists today.
 *
 * Scope: **Tier 1 only** — plain BVN/NIN number verification, no camera or
 * liveness capture. Prembly also offers a native `react-native-identity-kyc`
 * widget (Tier 2: camera/liveness) that this interface deliberately doesn't
 * model — see docs/00-SESSION-HANDOFF.md for why that was scoped out this
 * pass (needs a native rebuild, and withdrawal only requires Tier ≥ 1).
 */

export interface VerifyIdentityRequest {
  type: 'bvn' | 'nin';
  /** Raw, unhashed number — never persisted as-is; the caller hashes it
   * with a pepper before writing kyc_records (see the Edge Function). */
  number: string;
}

export interface VerifyIdentityResult {
  verified: boolean;
  /** Vendor's own reference for this specific verification call — stored
   * as kyc_records.provider_ref, distinct from the hashed BVN/NIN itself. */
  providerRef: string;
  /** Present when verified: true. Used for the bank-account name-match
   * step, never returned to the client beyond a plain "verified" boolean —
   * see submit-kyc's Edge Function. */
  identity?: {
    firstName: string;
    middleName: string | null;
    lastName: string;
  };
  /** true if the vendor's own watchlist/sanctions screening (bundled into
   * this same call, per docs/07-COMPLIANCE-LEGAL.md §2 — confirmed live,
   * not assumed) flagged a match. A flagged match is surfaced, never
   * silently ignored — see submit-kyc's handling. */
  watchlisted: boolean;
}

export interface KycProvider {
  readonly name: 'prembly';
  verifyIdentity(request: VerifyIdentityRequest): Promise<VerifyIdentityResult>;
}
