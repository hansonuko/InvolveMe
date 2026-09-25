import type { Metadata } from 'next';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

export const metadata: Metadata = {
  title: 'About',
  description: "Why InvolveMe exists, and what we're building toward.",
};

export default function AboutPage() {
  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>About</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            Messaging that respects the value of attention
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            Most chat apps make their money from your attention: ads, engagement loops, data.
            InvolveMe makes its money the same way its users do: from real conversations people
            actually choose to have.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-2">
        <AnimatedSection>
          <Card className="h-full">
            <h2 className="text-title font-bold text-foreground">What we believe</h2>
            <p className="mt-3 text-body text-muted">
              A message someone chooses to answer is worth something, to the sender, who gets a
              reply, and to the receiver, whose time and attention aren&apos;t free. InvolveMe
              builds that belief directly into the product instead of monetizing around it.
            </p>
          </Card>
        </AnimatedSection>
        <AnimatedSection delay={0.1}>
          <Card className="h-full">
            <h2 className="text-title font-bold text-foreground">What we&apos;re building</h2>
            <p className="mt-3 text-body text-muted">
              A chat app that feels as familiar as any other on day one, with a real economy
              underneath: escrow-protected payments, verified withdrawals, and fraud protection
              built the way a financial product should be, not bolted on afterward.
            </p>
          </Card>
        </AnimatedSection>
      </Section>
    </>
  );
}
