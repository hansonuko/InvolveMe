import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

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

export function HowItWorksContent() {
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
          <Eyebrow>Chat Credits</Eyebrow>
          <h2 className="mt-3 text-display font-extrabold text-foreground">
            Buy Chat Credits to message someone
          </h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            <div>
              <p className="text-body text-muted">
                Anyone wanting to get someone&apos;s time on chat with InvolveMe can buy Chat
                Credits, starting from just ₦100 and up. No subscription, no fixed plan — top up
                whenever you need to.
              </p>
              <p className="mt-4 rounded-card border border-border bg-surface px-5 py-4 text-caption text-muted">
                A small platform fee comes off what&apos;s released to the person who replies, the
                rest is theirs.
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
                <Link
                  href="/security"
                  className="font-semibold text-foreground-accent hover:underline"
                >
                  Security &amp; Trust
                </Link>{' '}
                page.
              </p>
              <p className="mt-4 rounded-card border border-border bg-surface px-5 py-4 text-caption text-muted">
                🔒 Chat Credits work the same way in an end-to-end-encrypted conversation too — the
                exact same buy-in, held-until-reply mechanism, just measured differently under the
                hood since an encrypted message can&apos;t be read to count its words.
              </p>
            </div>
          </div>
        </AnimatedSection>
      </Section>
    </>
  );
}
