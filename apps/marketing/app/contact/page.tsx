import type { Metadata } from 'next';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with the InvolveMe team.',
};

const CHANNELS = [
  {
    title: 'Support',
    body: "Questions about your account, a payment, or something that doesn't look right.",
    email: 'support@involveme.com',
  },
  {
    title: 'Security',
    body: 'Found a vulnerability or a security concern? We want to hear it directly.',
    email: 'security@involveme.com',
  },
  {
    title: 'Press & partnerships',
    body: 'Media inquiries, partnership proposals, and everything else.',
    email: 'hello@involveme.com',
  },
];

export default function ContactPage() {
  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>Contact</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            Talk to us
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            The app isn&apos;t open for public signup yet — this page is for reaching the team, not
            for creating an account.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="grid gap-6 md:grid-cols-3">
        {CHANNELS.map((c, i) => (
          <AnimatedSection key={c.title} delay={i * 0.08}>
            <Card className="h-full text-center">
              <h2 className="text-title font-bold text-foreground">{c.title}</h2>
              <p className="mt-3 text-body text-muted">{c.body}</p>
              <a
                href={`mailto:${c.email}`}
                className="mt-4 inline-block text-body font-semibold text-foreground-accent hover:underline"
              >
                {c.email}
              </a>
            </Card>
          </AnimatedSection>
        ))}
      </Section>
    </>
  );
}
