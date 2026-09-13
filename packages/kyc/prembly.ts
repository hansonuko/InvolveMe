/**
 * Prembly adapter — implements `KycProvider` (see provider.ts's header
 * comment). Confirmed live this session with a real BVN before being
 * trusted: auth works, the response shape matches what's coded below
 * (including a `billing_info` field the docs excerpt read while scoping
 * this didn't show — every call, successful or not, is billed by Prembly,
 * ~₦45/verification at the time this was checked), and — found only by
 * making a real call, not by reading docs — the BVN Basic response
 * already includes watchlist screening (`data.watchListed`), which
 * resolves what would otherwise have been an open compliance question
 * (docs/07-COMPLIANCE-LEGAL.md §2 requires screening on KYC completion;
 * Prembly's own docs excerpt read while scoping this didn't show that
 * field on the basic verification response, so it looked like it might
 * need a separate call — it doesn't).
 *
 * Two endpoints, chosen by `type`:
 * - BVN Basic: POST /verification/bvn_validation
 * - NIN Basic: POST /verification/vnin-basic
 * Both are synchronous (result in the same response, no webhook needed)
 * and take `{ number }` with an `x-api-key` header — no separate
 * Authorization header, per Prembly's own docs ("No other Authorization
 * header should be implemented... or set Authorization to 'No-Auth'").
 */

import type { KycProvider, VerifyIdentityRequest, VerifyIdentityResult } from './provider.ts';

export interface PremblyConfig {
  secretKey: string;
}

const BASE_URL = 'https://api.prembly.com';

interface PremblyBvnResponse {
  status: boolean;
  data?: {
    firstName?: string;
    lastName?: string;
    middleName?: string;
    watchListed?: string;
  };
  verification?: { reference?: string; verification_id?: string };
  reference_id?: string;
}

interface PremblyNinResponse {
  status: boolean;
  data?: {
    firstname?: string;
    surname?: string;
    middlename?: string;
  };
  verification?: { reference?: string; verification_id?: string };
  reference_id?: string;
}

export function createPremblyProvider(config: PremblyConfig): KycProvider {
  return {
    name: 'prembly',

    async verifyIdentity(request: VerifyIdentityRequest): Promise<VerifyIdentityResult> {
      const path =
        request.type === 'bvn' ? '/verification/bvn_validation' : '/verification/vnin-basic';

      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          'x-api-key': config.secretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ number: request.number }),
      });

      const body = await res.json();

      if (!res.ok) {
        throw new Error(`Prembly ${request.type} verification request failed: HTTP ${res.status}`);
      }

      const providerRef =
        body.reference_id ??
        body.verification?.reference ??
        body.verification?.verification_id ??
        '';

      if (request.type === 'bvn') {
        const parsed = body as PremblyBvnResponse;
        if (!parsed.status || !parsed.data) {
          return { verified: false, providerRef, watchlisted: false };
        }
        return {
          verified: true,
          providerRef,
          watchlisted: !!parsed.data.watchListed,
          identity: {
            firstName: parsed.data.firstName ?? '',
            middleName: parsed.data.middleName || null,
            lastName: parsed.data.lastName ?? '',
          },
        };
      }

      const parsed = body as PremblyNinResponse;
      if (!parsed.status || !parsed.data) {
        return { verified: false, providerRef, watchlisted: false };
      }
      // NIN Basic's own response (confirmed against Prembly's docs) has no
      // watchlist field at all, unlike BVN Basic — not assumed equivalent.
      return {
        verified: true,
        providerRef,
        watchlisted: false,
        identity: {
          firstName: parsed.data.firstname ?? '',
          middleName: parsed.data.middlename || null,
          lastName: parsed.data.surname ?? '',
        },
      };
    },
  };
}
