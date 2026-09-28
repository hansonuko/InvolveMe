import type { Metadata } from 'next';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';
import { earningsForBytes, earningsForWords, formatNaira, getPublicPricing } from '@/lib/pricing';

export const metadata: Metadata = {
  title: 'How it works',
  description: "How InvolveMe's earn-per-message credit system actually works.",
};

const STEPS = [
  {
    step: '1',
    title: 'Someone messages you',
    body: "Its cost in credits is calculated from its length and shown to them before they hit send, so it's always clear they're the one paying, not you.",
  },
  {
    step: '2',
    title: "It's held safely, waiting for your reply",
    body: "Their credits are debited right away, but held, not paid out to anyone yet. It's waiting on you.",
  },
  {
    step: '3',
    title: "The moment you reply, it's yours",
    body: 'Your reply releases the held credits straight to your earnings balance. No reply, no earnings: unanswered messages refund to the sender automatically.',
  },
  {
    step: '4',
    title: 'Cash out to your bank',
    body: 'Verified earners can withdraw to a linked, name-matched bank account.',
  },
];

export default async function HowItWorksPage() {
  const pricing = await getPublicPricing();
  const exampleWords = pricing.message_word_block_size;
  const exampleEarnings = earningsForWords(pricing, exampleWords);
  const exampleBytes = pricing.message_byte_block_size;
  const exampleByteEarnings = earningsForBytes(pricing, exampleBytes);

  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>How it works</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            You get paid the moment someone needs your reply
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            No subscriptions, no ads. People pay a small amount to message you, and you earn from
            every reply. Chat is live at launch, with pay-per-minute calls coming next.
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
          <Eyebrow>The earning value chain</Eyebrow>
          <h2 className="mt-3 text-display font-extrabold text-foreground">
            Who earns first, and why
          </h2>
          <p className="mt-4 max-w-2xl text-body text-muted">
            The very first message in a new conversation is pure spend: it goes straight into
            escrow, nothing&apos;s been earned yet, because nobody has given their time in response
            to it. The first person to <span className="font-semibold">reply</span> is the first to
            earn, that reply is the moment real value actually happens. From there, the roles flip
            with every message: your reply earns you money, and if you send the next one, it&apos;s
            your turn to hold funds for the other person&apos;s reply, the same mechanism, running
            in both directions.
          </p>
        </AnimatedSection>
      </Section>

      <Section>
        <AnimatedSection>
          <Eyebrow>The actual formula</Eyebrow>
          <h2 className="mt-3 text-display font-extrabold text-foreground">
            What you earn per reply
          </h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            <div>
              <p className="text-body text-muted">
                1 credit ={' '}
                <span className="font-semibold text-foreground">
                  {formatNaira(pricing.credit_unit_kobo)}
                </span>
                . A message costs the sender{' '}
                <span className="font-semibold text-foreground">
                  {pricing.message_base_credits} credits
                </span>{' '}
                for every {pricing.message_word_block_size} words or part thereof, rounded up. A
                small platform fee comes off what you earn when escrow releases, the rest is yours.
              </p>
              <p className="mt-4 rounded-card border border-border bg-surface px-5 py-4 text-caption text-muted">
                Example: reply to a {exampleWords}-word message and you earn {exampleEarnings}{' '}
                credits, {formatNaira(exampleEarnings * pricing.credit_unit_kobo)}, after the
                platform fee. Messages are capped at {pricing.message_max_words} words.
              </p>
            </div>
            <div>
              <p className="text-body text-muted">
                If you never reply, the sender&apos;s held credits are automatically refunded to
                them after a set window, you only ever earn from conversations you actually showed
                up for.
              </p>
              <p className="mt-4 text-body text-muted">
                That platform fee also funds the escrow, KYC, and fraud-protection systems described
                on the{' '}
                <a
                  href="/security"
                  className="font-semibold text-foreground-accent hover:underline"
                >
                  Security &amp; Trust
                </a>{' '}
                page.
              </p>
              <p className="mt-4 rounded-card border border-border bg-surface px-5 py-4 text-caption text-muted">
                🔒 In an end-to-end-encrypted conversation, the same formula applies to the
                message&apos;s encrypted byte length instead of its word count, since that&apos;s
                the only thing about an encrypted message the server can ever measure. A{' '}
                {exampleBytes}-byte encrypted message earns {exampleByteEarnings} credits (
                {formatNaira(exampleByteEarnings * pricing.credit_unit_kobo)}), calibrated to land
                on the same numbers as an equivalent-length unencrypted message. Capped at{' '}
                {pricing.message_max_bytes} bytes per message.
              </p>
            </div>
          </div>
        </AnimatedSection>
      </Section>
    </>
  );
}
