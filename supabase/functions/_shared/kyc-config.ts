// _shared/kyc-config.ts — reads the env vars submit-kyc needs into a
// PremblyConfig, mirroring _shared/flutterwave-config.ts's pattern.

import type { PremblyConfig } from '../../../packages/kyc/prembly.ts';

export function loadPremblyConfig(): PremblyConfig {
  return {
    secretKey: Deno.env.get('PREMBLY_SECRET_KEY') ?? '',
  };
}

export function loadKycHashPepper(): string {
  return Deno.env.get('KYC_HASH_PEPPER') ?? '';
}
