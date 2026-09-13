/**
 * Normalizes a user-typed Nigerian phone number to E.164
 * (`+234XXXXXXXXXX`), which is what Supabase's phone-auth `signInWithOtp`/
 * `verifyOtp` require. Without this, a number typed in the everyday local
 * format (`0902...`, the placeholder text notwithstanding) gets sent
 * exactly as typed and Supabase rejects it — found by testing the actual
 * app on a real phone, not by reading the auth screen's code.
 *
 * Deliberately Nigeria-only (NGN-only app per CLAUDE.md) rather than a full
 * libphonenumber integration — "stay lite" per docs/03-ECONOMY-LEDGER.md.
 * Revisit if/when other countries are supported.
 */
export function toE164NigerianPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('234')) return `+${digits}`;
  if (digits.startsWith('0')) return `+234${digits.slice(1)}`;
  return `+234${digits}`;
}
