import type { Metadata } from 'next';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import { formatNaira, getPublicPricing } from '@/lib/pricing';

export const metadata: Metadata = {
  title: 'How it works',
  description: "How InvolveMe's pay-per-message credit system actually works.",
};

const STEPS = [
  {
    step: '1',
    title: 'You send a message',
    body: "Its cost in credits is calculated from its length and shown to you before you hit send, so there's never a surprise charge after the fact.",
  },
  {
    step: '2',
    title: 'Your credits go into escrow',
    body: "They're debited from your balance right away, but held, not paid out to anyone yet.",
  },
  {
    step: '3',
    title: 'They reply, escrow releases',
    body: 'The moment the other person replies, the held credits move to their earnings balance. No reply, no charge: unanswered messages refund automatically.',
  },
  {
    step: '4',
    title: 'Earnings become real cash',
    body: 'Verified users can withdraw their earnings to a linked, name-matched bank account.',
  },
];

export default async function HowItWorksPage() {
  const pricing = await getPublicPricing();

  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>How it works</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            One simple rule: every message has a cost, held until it&apos;s answered
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            No subscriptions, no ads. You buy credits, spend a small amount per message, and the
            people who reply to you earn from doing so.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-2">
        {STEPS.map((s, i) => (
          <AnimatedSection key={s.step} delay={i * 0.08}>
            <Card className="h-full">
              <span className="text-title font-extrabold text-credit">{s.step}</span>
              <h2 className="mt-2 text-title font-bold text-foreground">{s.title}</h2>
              <p className="mt-3 text-body text-muted">{s.body}</p>
            </Card>
          </AnimatedSection>
        ))}
      </Section>

      <Section className="rounded-sheet bg-surface-alt">
        <AnimatedSection>
          <Eyebrow>The actual formula</Eyebrow>
          <h2 className="mt-3 text-display font-extrabold text-foreground">What a message costs</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            <div>
              <p className="text-body text-muted">
                1 credit ={' '}
                <span className="font-semibold text-foreground">
                  {formatNaira(pricing.credit_unit_kobo)}
                </span>
                . A message costs{' '}
                <span className="font-semibold text-foreground">
                  {pricing.message_base_credits} credits
                </span>{' '}
                for every {pricing.message_word_block_size} words or part thereof, rounded up, so a
                short message and a long one are priced fairly by length, not a flat fee that
                rewards padding. Messages are capped at {pricing.message_max_words} words.
              </p>
              <p className="mt-4 rounded-card border border-border bg-surface px-5 py-4 text-caption text-muted">
                Example: a {pricing.message_word_block_size}-word message costs{' '}
                {pricing.message_base_credits} credits ={' '}
                {formatNaira(pricing.message_base_credits * pricing.credit_unit_kobo)}. A{' '}
                {pricing.message_word_block_size * 2}-word message costs{' '}
                {pricing.message_base_credits * 2} credits.
              </p>
            </div>
            <div>
              <p className="text-body text-muted">
                If the person you messaged never replies, InvolveMe automatically refunds the held
                credits back to your balance after a set window, so you only ever pay for
                conversations that actually happen.
              </p>
              <p className="mt-4 text-body text-muted">
                A small platform fee applies when you top up credits and when earnings are released,
                funding the escrow, KYC, and fraud-protection systems described on the{' '}
                <a
                  href="/security"
                  className="font-semibold text-foreground-accent hover:underline"
                >
                  Security &amp; Trust
                </a>{' '}
                page.
              </p>
            </div>
          </div>
        </AnimatedSection>
      </Section>
    </>
  );
}
