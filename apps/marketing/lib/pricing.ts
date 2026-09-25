// Server-side fetch of the public pricing figures shown on the Pricing and
// How it works pages — never hand-copied numbers (docs/15 §2), always read
// from the get-public-pricing Edge Function, which itself whitelists a few
// safe fields out of `pricing_config` (see that function's header comment).
//
// SUPABASE_URL is the same server-only env var apps/admin already uses
// (see apps/admin/lib/supabase-admin.ts) — this fetch runs on the server
// (Server Component, ISR-revalidated), never in the browser, so no
// NEXT_PUBLIC_* var is needed here.

export interface PublicPricing {
  credit_unit_kobo: number;
  message_base_credits: number;
  message_word_block_size: number;
  message_max_words: number;
  platform_topup_fee_bps: number;
  platform_earning_take_bps: number;
}

const FALLBACK: PublicPricing = {
  // Matches supabase/migrations/20260912072744_seed_pricing_config.sql's
  // v1 defaults — used only if the live endpoint is unreachable at build
  // time, so the site still renders something correct-as-of-today rather
  // than an empty page. Real requests always prefer the live fetch below.
  credit_unit_kobo: 1000,
  message_base_credits: 2,
  message_word_block_size: 50,
  message_max_words: 500,
  platform_topup_fee_bps: 200,
  platform_earning_take_bps: 2000,
};

export async function getPublicPricing(): Promise<PublicPricing> {
  const supabaseUrl = process.env.SUPABASE_URL;
  if (!supabaseUrl) {
    console.error('getPublicPricing: SUPABASE_URL is not set, serving fallback figures.');
    return FALLBACK;
  }

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/get-public-pricing`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error(`get-public-pricing returned ${res.status}`);
    return (await res.json()) as PublicPricing;
  } catch (e) {
    console.error('getPublicPricing: live fetch failed, serving fallback figures:', e);
    return FALLBACK;
  }
}

export function formatNaira(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function creditsForWords(pricing: PublicPricing, words: number): number {
  const capped = Math.min(words, pricing.message_max_words);
  return pricing.message_base_credits * Math.ceil(capped / pricing.message_word_block_size);
}

// Net credits the replier actually earns from a message of this length,
// the sender's cost minus the platform's cut on the escrow release
// (packages/legal-content/terms.ts §5 — a platform fee is deducted from
// credit released to a recipient when their reply clears escrow). This is
// the number the earn-first repositioning shows, not just what a sender
// pays, which is all creditsForWords() alone tells you.
export function earningsForWords(pricing: PublicPricing, words: number): number {
  const cost = creditsForWords(pricing, words);
  return cost - Math.round((cost * pricing.platform_earning_take_bps) / 10000);
}
