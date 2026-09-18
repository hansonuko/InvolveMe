// _shared/two-step-config.ts — mirrors _shared/kyc-config.ts's
// loadKycHashPepper pattern for the two-step-verification PIN's pepper.

export function loadTwoStepPinPepper(): string {
  return Deno.env.get('TWO_STEP_PIN_PEPPER') ?? '';
}
