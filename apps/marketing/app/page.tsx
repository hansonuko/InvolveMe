import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { CountdownTimer } from '@/components/CountdownTimer';
import { Card, Eyebrow, Section } from '@/components/Section';

const VALUE_PROPS = [
  {
    title: 'Every message has a price',
    body: "No ads, no data-harvesting business model. You pay a small, transparent credit cost per message, and the person you're messaging earns from replying.",
  },
  {
    title: 'Money held in escrow, not spent blind',
    body: 'Your credits are held the moment you send a message and only released to the other person once they reply. Nothing is taken for a message that goes unanswered.',
  },
  {
    title: 'Built like a bank, not a chat toy',
    body: 'Double-entry ledger accounting, KYC-gated withdrawals, and real fraud monitoring sit under a chat experience that still feels as familiar as any messaging app.',
  },
];

export default function HomePage() {
  return (
    <>
      <Section className="pb-8 pt-12 text-center">
        <AnimatedSection>
          <Eyebrow>Launching December 1, 2026</Eyebrow>
          <div className="mt-6">
            <CountdownTimer />
          </div>
          <p className="mx-auto mt-6 max-w-md text-caption text-muted">
            Sign up before launch and get 100 non-withdrawable chat credits to start with, on us.
            See the{' '}
            <Link href="/guide" className="font-semibold text-foreground-accent hover:underline">
              full guide
            </Link>{' '}
            for details.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="pb-10 pt-8 text-center md:pt-12">
        <AnimatedSection>
          <Eyebrow>Pay-per-message chat</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-3xl text-display font-extrabold leading-tight text-foreground md:text-[44px]">
            A chat app where your time, and theirs, has real value
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-body text-muted">
            InvolveMe looks and feels like the messaging app you already know. The difference: every
            message costs a small, transparent number of credits, held safely until the person
            you&apos;re talking to actually replies.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/signup"
              className="rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
            >
              Sign up
            </Link>
            <Link
              href="/how-it-works"
              className="rounded-pill border border-border px-7 py-3.5 text-body font-semibold text-foreground transition-colors hover:border-accent"
            >
              See how it works
            </Link>
          </div>
          <div className="mt-6">
            <Link
              href="/pricing"
              className="text-body font-semibold text-foreground-accent hover:underline"
            >
              View pricing
            </Link>
          </div>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-3">
        {VALUE_PROPS.map((item, i) => (
          <AnimatedSection key={item.title} delay={i * 0.1}>
            <Card className="h-full">
              <h2 className="text-title font-bold text-foreground">{item.title}</h2>
              <p className="mt-3 text-body text-muted">{item.body}</p>
            </Card>
          </AnimatedSection>
        ))}
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <Eyebrow>The mechanism</Eyebrow>
          <h2 className="mx-auto mt-3 max-w-2xl text-display font-extrabold text-foreground">
            Send → escrow → reply → earn
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            A message you send debits your credit balance into escrow immediately. If the other
            person replies, escrow releases to their earnings balance. If they never do, your
            credits are refunded automatically, so you&apos;re never charged for silence.
          </p>
          <Link
            href="/security"
            className="mt-8 inline-block text-body font-semibold text-foreground-accent hover:underline"
          >
            Read how we protect that money →
          </Link>
        </AnimatedSection>
      </Section>
    </>
  );
}
