import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { CountdownTimer } from '@/components/CountdownTimer';
import { Card, Eyebrow, Section } from '@/components/Section';
import { WhoItsFor } from '@/components/WhoItsFor';

const VALUE_PROPS = [
  {
    title: 'Every reply is a paycheck',
    body: "No ads, no data-harvesting business model. Someone pays a small, transparent credit cost to message you, and the moment you reply, it's yours to keep.",
  },
  {
    title: 'The money is already waiting for you',
    body: "The credits are debited from the sender's balance and held safely the second they message you. Reply, and they land in your earnings, no chasing anyone for payment.",
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
          <Eyebrow>Earn per message</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-3xl text-display font-extrabold leading-tight text-foreground md:text-[44px]">
            Get paid every time someone needs your time
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-body text-muted">
            InvolveMe looks and feels like the messaging app you already know. The difference:
            people pay to message you, and every reply you send earns you real money, held safely
            until the moment you respond.
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

      <WhoItsFor />

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <Eyebrow>The mechanism</Eyebrow>
          <h2 className="mx-auto mt-3 max-w-2xl text-display font-extrabold text-foreground">
            They reach out → it&apos;s held for you → you reply → you earn
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            Someone messages you, their credits are debited into escrow immediately, waiting on you.
            The moment you reply, that escrow releases straight to your earnings. If you never
            reply, they&apos;re refunded automatically, you only ever earn from conversations you
            actually show up for. Chat is live at launch; pay-per-minute voice and video calls are
            next, so every way people need your time becomes income.
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
