import type { Metadata } from 'next';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

export const metadata: Metadata = {
  title: 'Security & Trust',
  description: 'How InvolveMe protects your money and your account.',
};

const PROTECTIONS = [
  {
    title: 'Escrow, not blind spending',
    body: 'Every credit you send is held, not immediately paid out. It only reaches the other person once they actually reply, and refunds automatically if they never do.',
  },
  {
    title: 'Double-entry ledger accounting',
    body: "Every credit that moves is recorded as a matched pair of entries, the same principle real accounting systems use. Balances are never a number someone edited directly: they're the sum of a permanent, auditable history.",
  },
  {
    title: 'Verified withdrawals only',
    body: 'Earnings can only be withdrawn to a bank account that has passed identity verification (KYC) and a name-match check against the account holder. Money never leaves to an unverified destination, including on the automatic payout schedule.',
  },
  {
    title: 'Active fraud monitoring',
    body: 'Automated systems watch for the patterns that matter most in a pay-per-message product, coordinated accounts messaging each other to cycle money, unusual velocity, device-level signals, and flag them for human review rather than acting silently.',
  },
  {
    title: 'A reserve buffer, for when things go wrong',
    body: "A portion of platform revenue is held back specifically to absorb chargebacks and payment disputes, so a bad-faith top-up doesn't become someone else's problem.",
  },
  {
    title: 'Signed, verified payment webhooks',
    body: 'Every payment confirmation is cryptographically verified and processed exactly once. Replayed or spoofed payment events are rejected before they ever touch a balance.',
  },
];

export default function SecurityPage() {
  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>Security &amp; Trust</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            Real protections, not marketing language
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            InvolveMe moves real money between people based on real conversations. Here&apos;s what
            actually stands between your balance and something going wrong. Every item below is a
            shipped mechanism, not a promise.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {PROTECTIONS.map((p, i) => (
          <AnimatedSection key={p.title} delay={(i % 3) * 0.08}>
            <Card className="h-full">
              <h2 className="text-title font-bold text-foreground">{p.title}</h2>
              <p className="mt-3 text-body text-muted">{p.body}</p>
            </Card>
          </AnimatedSection>
        ))}
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">Found a problem?</h2>
          <p className="mx-auto mt-3 max-w-md text-body text-muted">
            If you believe you&apos;ve found a security issue, we want to hear from you directly.
          </p>
          <a
            href="/contact"
            className="mt-6 inline-block rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
          >
            Contact us
          </a>
        </AnimatedSection>
      </Section>
    </>
  );
}
