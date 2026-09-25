import type { Metadata } from 'next';
import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import { creditsForWords, formatNaira, getPublicPricing } from '@/lib/pricing';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'InvolveMe credit pricing: transparent, pay-per-message costs, no subscriptions.',
};

export default async function PricingPage() {
  const pricing = await getPublicPricing();
  const examples = [10, 50, 150, 500].map((words) => ({
    words,
    credits: creditsForWords(pricing, words),
  }));

  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>Pricing</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            One credit price. No subscriptions, no hidden fees.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            Buy credits, spend them message by message. These figures come straight from our live
            pricing configuration, not a page someone forgot to update.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-2">
        <AnimatedSection>
          <Card className="h-full text-center">
            <p className="text-caption font-semibold uppercase tracking-wide text-muted">
              Credit price
            </p>
            <p className="mt-4 text-balance font-extrabold text-foreground">
              1 credit = {formatNaira(pricing.credit_unit_kobo)}
            </p>
            <p className="mt-4 text-body text-muted">
              A small platform fee applies on top-ups, enough to cover payment processing and the
              fraud/escrow infrastructure that keeps your money safe.
            </p>
          </Card>
        </AnimatedSection>

        <AnimatedSection delay={0.1}>
          <Card className="h-full">
            <p className="text-caption font-semibold uppercase tracking-wide text-muted">
              What messages cost
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {examples.map((e) => (
                <li
                  key={e.words}
                  className="flex items-center justify-between border-b border-border pb-3 text-body last:border-0 last:pb-0"
                >
                  <span className="text-muted">~{e.words} words</span>
                  <span className="font-semibold text-foreground">
                    {e.credits} credits · {formatNaira(e.credits * pricing.credit_unit_kobo)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </AnimatedSection>
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">
            Want the exact formula behind these numbers?
          </h2>
          <Link
            href="/how-it-works"
            className="mt-4 inline-block text-body font-semibold text-foreground-accent hover:underline"
          >
            See how it works →
          </Link>
        </AnimatedSection>
      </Section>
    </>
  );
}
