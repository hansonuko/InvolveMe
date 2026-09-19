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
  const e164 = toE164Phone(raw, '+234');

  // A real, common phonebook data-entry pattern, worth normalizing rather
  // than treating as a different number from the same person's correctly-
  // formatted `users.phone`: someone types the local trunk format
  // ("0802...") into a contact, then later prefixes "+234" without
  // deleting the leading trunk `0` ("+2340802..."), or a contact-sync/
  // export tool does the same — `toE164Phone` above trusts anything
  // already starting with `+` as-is, so it never catches this. Scoped to
  // this Nigeria-specific wrapper only (not the general `toE164Phone`,
  // which the signup country-picker flow uses for arbitrary countries
  // where a leading `0` after the dial code isn't necessarily a mistake)
  // — this app's own contact-matching is Nigeria-only today anyway, per
  // this function's own header comment (2026-09-19, group-creation
  // contact-detection punch-list follow-up: "should... find users
  // already on InvolveMe accurately").
  if (e164.startsWith('+2340')) {
    return `+234${e164.slice(5)}`;
  }
  return e164;
}
