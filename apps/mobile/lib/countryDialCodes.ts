/**
 * Country + E.164 dial-code list for the phone-entry screen's country
 * picker (docs/10-UX-REFINEMENT-BACKLOG.md Batch E's E2 spec item 1).
 *
 * Deliberately static client-side data, not read from
 * `country_currency_config` (20260917130000_multicurrency_schema.sql)
 * despite covering the same 23-country starter set: that table's RLS
 * policy is `to authenticated` only, and the phone-entry screen runs
 * *before* any session exists — there's no authenticated client yet to
 * read it with. Dial codes are also stable ITU-assigned facts, not
 * ops-tunable config the way `pricing_config` is (CLAUDE.md rule #9),
 * so there's nothing to gain from a DB round-trip here even if RLS
 * allowed it.
 *
 * Same 23 countries as `country_currency_config`'s seed, for consistency
 * between what's selectable at signup (phone country code) and at
 * onboarding (currency country) — not exhaustive ISO 3166-1, same
 * "starter set, not a guess at all ~195" reasoning as that table's own
 * comment.
 */
export interface CountryDialCode {
  code: string;
  name: string;
  dialCode: string;
}

export const COUNTRY_DIAL_CODES: CountryDialCode[] = [
  { code: 'NG', name: 'Nigeria', dialCode: '+234' },
  { code: 'GH', name: 'Ghana', dialCode: '+233' },
  { code: 'KE', name: 'Kenya', dialCode: '+254' },
  { code: 'ZA', name: 'South Africa', dialCode: '+27' },
  { code: 'TZ', name: 'Tanzania', dialCode: '+255' },
  { code: 'UG', name: 'Uganda', dialCode: '+256' },
  { code: 'RW', name: 'Rwanda', dialCode: '+250' },
  { code: 'ZM', name: 'Zambia', dialCode: '+260' },
  { code: 'CM', name: 'Cameroon', dialCode: '+237' },
  { code: 'CI', name: "Côte d'Ivoire", dialCode: '+225' },
  { code: 'SN', name: 'Senegal', dialCode: '+221' },
  { code: 'EG', name: 'Egypt', dialCode: '+20' },
  { code: 'US', name: 'United States', dialCode: '+1' },
  { code: 'GB', name: 'United Kingdom', dialCode: '+44' },
  { code: 'CA', name: 'Canada', dialCode: '+1' },
  { code: 'DE', name: 'Germany', dialCode: '+49' },
  { code: 'FR', name: 'France', dialCode: '+33' },
  { code: 'IE', name: 'Ireland', dialCode: '+353' },
  { code: 'ES', name: 'Spain', dialCode: '+34' },
  { code: 'IT', name: 'Italy', dialCode: '+39' },
  { code: 'NL', name: 'Netherlands', dialCode: '+31' },
  { code: 'AE', name: 'United Arab Emirates', dialCode: '+971' },
  { code: 'IN', name: 'India', dialCode: '+91' },
];

/** Nigeria stays first and default — CLAUDE.md's "NGN-only for now" posture. */
export const DEFAULT_COUNTRY_DIAL_CODE = COUNTRY_DIAL_CODES[0];
