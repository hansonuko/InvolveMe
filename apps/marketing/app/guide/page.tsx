import type { Metadata } from 'next';
import Link from 'next/link';
import { AnimatedSection } from '@/components/AnimatedSection';
import { Card, Eyebrow, Section } from '@/components/Section';

export const metadata: Metadata = {
  title: 'Guide',
  description: 'How to get started with InvolveMe: signing up, chat credits, and withdrawals.',
};

// Every specific claim below (the 24-hour withdrawal target, the prohibited-
// conduct categories, moderation, reporting) is a plain-language translation
// of packages/legal-content/terms.ts's real §7/§10-12, the same "consumer-
// facing translation of a real, shipped/committed mechanism" principle
// app/security/page.tsx already uses. Nothing here is invented copy.
const STEPS = [
  {
    step: '1',
    title: 'Sign up early',
    body: (
      <>
        Confirm your phone number on the{' '}
        <Link href="/signup" className="font-semibold text-foreground-accent hover:underline">
          Sign up
        </Link>{' '}
        page. Early adopters who sign up before launch get 100 non-withdrawable chat credits to
        start with, a real commitment we&apos;re making for launch day, December 1, 2026, not a
        balance that exists yet. &quot;Non-withdrawable&quot; means these credits let you try
        sending messages, they can&apos;t be converted to cash.
      </>
    ),
  },
  {
    step: '2',
    title: 'Download and finish setup',
    body: (
      <>
        Once InvolveMe is live, install it from the{' '}
        <Link href="/download" className="font-semibold text-foreground-accent hover:underline">
          Download
        </Link>{' '}
        page and finish setting up your profile in the app. That&apos;s also where your phone
        verification from step 1 gets tied to a real account.
      </>
    ),
  },
  {
    step: '3',
    title: 'How chat credits work',
    body: (
      <>
        Sending a message costs the sender a small number of credits, calculated from its length.
        Those credits are held until the other person replies, then released to them as earnings. No
        reply, no charge: unanswered messages refund automatically. See{' '}
        <Link href="/how-it-works" className="font-semibold text-foreground-accent hover:underline">
          How it works
        </Link>{' '}
        for the exact formula and{' '}
        <Link href="/pricing" className="font-semibold text-foreground-accent hover:underline">
          Pricing
        </Link>{' '}
        for current rates.
      </>
    ),
  },
  {
    step: '4',
    title: 'Withdrawing your earnings',
    body: (
      <>
        Earnings become withdrawable cash once you&apos;ve completed identity verification (KYC) and
        linked a bank account in your name, we never pay out to an unverified identity or a
        mismatched account. We aim to make verified withdrawals available within 24 hours, and an
        automatic sweep means you don&apos;t have to remember to withdraw yourself.
      </>
    ),
  },
  {
    step: '5',
    title: 'Community standards',
    body: (
      <>
        InvolveMe is for genuine conversation between consenting adults. Multi-accounting,
        wash-chatting, spam or automated messaging, harassment, and soliciting prohibited services
        are all against our Terms of Service, and we mean it: automated systems and manual review
        watch for these patterns, and violations can mean message rejection, credit forfeiture,
        wallet freezing, or account suspension. You can block anyone at any time, and reporting a
        user or conversation is reviewed by our team directly. We take every report seriously. See{' '}
        <Link href="/security" className="font-semibold text-foreground-accent hover:underline">
          Security &amp; Trust
        </Link>{' '}
        for the fraud-prevention systems behind this.
      </>
    ),
  },
];

export default function GuidePage() {
  return (
    <>
      <Section className="pb-10 pt-16 text-center">
        <AnimatedSection>
          <Eyebrow>Guide</Eyebrow>
          <h1 className="mx-auto mt-4 max-w-2xl text-display font-extrabold text-foreground">
            Getting started with InvolveMe
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-body text-muted">
            Everything you need to know before launch: signing up, how chat credits work, and how to
            withdraw what you earn.
          </p>
        </AnimatedSection>
      </Section>

      <Section className="flex flex-col gap-6">
        {STEPS.map((s, i) => (
          <AnimatedSection key={s.step} delay={i * 0.06}>
            <Card>
              <div className="flex gap-5">
                <span className="text-title font-extrabold text-credit">{s.step}</span>
                <div>
                  <h2 className="text-title font-bold text-foreground">{s.title}</h2>
                  <p className="mt-2 text-body text-muted">{s.body}</p>
                </div>
              </div>
            </Card>
          </AnimatedSection>
        ))}
      </Section>

      <Section className="rounded-sheet bg-surface-alt text-center">
        <AnimatedSection>
          <h2 className="text-title font-bold text-foreground">Ready to get started?</h2>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/signup"
              className="rounded-pill bg-accent px-7 py-3.5 text-body font-semibold text-on-accent transition-colors hover:bg-accent-pressed"
            >
              Sign up
            </Link>
            <Link
              href="/contact"
              className="rounded-pill border border-border px-7 py-3.5 text-body font-semibold text-foreground transition-colors hover:border-accent"
            >
              Contact us
            </Link>
          </div>
        </AnimatedSection>
      </Section>
    </>
  );
}
