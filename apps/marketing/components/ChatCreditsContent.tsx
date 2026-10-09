import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

const STEPS = [
  {
    title: 'Top up Chat Credits',
    body: 'Add Chat Credits to your balance any time, starting from just ₦100 and up — no subscription, no fixed plan.',
  },
  {
    title: 'Spend them to message someone',
    body: "Use your Chat Credits to message anyone on InvolveMe. It's their time you're asking for, and Chat Credits are how you show you mean it.",
  },
  {
    title: 'They earn the moment they reply',
    body: "Your credits are held safely until the other person replies, then released straight to their earnings. No reply, no charge — it's refunded to you automatically.",
  },
];

export function ChatCreditsContent() {
  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>Chat Credits</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            Get someone&apos;s time on chat, starting from ₦100
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            Chat Credits are how you message someone on InvolveMe — a simple top-up, not a
            subscription. Buy as little or as much as you need, whenever you need it.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <AnimatedSection key={s.title} delay={i * 0.08}>
            <Card className="h-full">
              <h2 className="text-title font-bold text-foreground">{s.title}</h2>
              <p className="mt-3 text-body text-muted">{s.body}</p>
            </Card>
          </AnimatedSection>
        ))}
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">
            Want to understand the full mechanism?
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
