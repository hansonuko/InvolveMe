/**
 * Normalizes a user-typed phone number to E.164 given the dial code the
 * user selected on the phone-entry screen's country picker
 * (docs/10-UX-REFINEMENT-BACKLOG.md Batch E's E2 spec item 1, generalized
 * session 18 — previously Nigeria-only, see `toE164NigerianPhone` below).
 * Without this, a number typed in the everyday local format (`0902...`)
 * gets sent exactly as typed and Supabase's phone auth rejects it — found
 * by testing the actual app on a real phone, not by reading the auth
 * screen's code (session 0).
 *
 * Deliberately not a full libphonenumber integration — "stay lite" per
 * docs/03-ECONOMY-LEDGER.md — just the same three shapes a user's local
 * dialing habit actually produces: already-international (`+...`), typed
 * with the dial code but no `+`, or typed in local format with a leading
 * trunk `0`.
 */
export function toE164Phone(raw: string, dialCode: string): string {
  const digits = raw.replace(/[^\d+]/g, '');

  if (digits.startsWith('+')) return digits;

  const dialDigits = dialCode.replace('+', '');
  if (digits.startsWith(dialDigits)) return `+${digits}`;
  if (digits.startsWith('0')) return `${dialCode}${digits.slice(1)}`;
  return `${dialCode}${digits}`;
}

/**
 * Nigeria-specific convenience wrapper — kept for the three call sites
 * that intentionally still assume Nigeria (find-user-by-phone lookup and
 * device-contacts matching in `app/(tabs)/chats.tsx`/`wallet.tsx`), which
 * are out of scope for this generalization: a phone-number *lookup* has no
 * country-picker context to draw a dial code from, unlike the phone-entry
 * screen itself. Revisit those call sites separately if/when they need to
 * support looking up a non-Nigerian number.
 */
export function toE164NigerianPhone(raw: string): string {
  return toE164Phone(raw, '+234');
}
